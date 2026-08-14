import * as diagch from 'diagnostics_channel';
import { URL } from 'url';
import { LRUMap, debug, startInactiveSpan, SPAN_STATUS_ERROR, getClient, shouldPropagateTraceForUrl, withActiveSpan, getTraceData } from '@sentry/core';
import { DEBUG_BUILD } from '../../../debug-build.js';
import { ATTR_URL_QUERY, ATTR_URL_PATH, ATTR_URL_FULL, ATTR_HTTP_REQUEST_METHOD_ORIGINAL, ATTR_HTTP_RESPONSE_STATUS_CODE, ATTR_URL_SCHEME, ATTR_HTTP_REQUEST_METHOD, ATTR_SERVER_ADDRESS, ATTR_SERVER_PORT, ATTR_USER_AGENT_ORIGINAL, ATTR_NETWORK_PEER_PORT, ATTR_NETWORK_PEER_ADDRESS } from './semconv.js';

const SPAN_KIND_CLIENT = 2;
function safeExecute(fn, onError) {
  try {
    return fn();
  } catch (error) {
    onError(error);
    return void 0;
  }
}
class UndiciInstrumentation {
  constructor(config = {}) {
    // Keep ref to avoid https://github.com/nodejs/node/issues/42170 bug and for unsubscribing.
    this._channelSubs = [];
    this._spanFromReq = /* @__PURE__ */ new WeakMap();
    // Caches trace-propagation decisions per URL so we don't recompute the `tracePropagationTargets` regexes per request.
    this._propagationDecisionMap = new LRUMap(100);
    this._config = config;
  }
  disable() {
    this._channelSubs.forEach((sub) => sub.unsubscribe());
    this._channelSubs.length = 0;
  }
  /** Subscribe to the undici diagnostics channels (idempotent). */
  enable() {
    if (this._channelSubs.length > 0) {
      return;
    }
    this.subscribeToChannel("undici:request:create", this.onRequestCreated.bind(this));
    this.subscribeToChannel("undici:client:sendHeaders", this.onRequestHeaders.bind(this));
    this.subscribeToChannel("undici:request:headers", this.onResponseHeaders.bind(this));
    this.subscribeToChannel("undici:request:trailers", this.onDone.bind(this));
    this.subscribeToChannel("undici:request:error", this.onError.bind(this));
  }
  subscribeToChannel(diagnosticChannel, onMessage) {
    const [major = 0, minor = 0] = process.version.replace("v", "").split(".").map((n) => Number(n));
    const useNewSubscribe = major > 18 || major === 18 && minor >= 19;
    let unsubscribe;
    if (useNewSubscribe) {
      diagch.subscribe?.(diagnosticChannel, onMessage);
      unsubscribe = () => diagch.unsubscribe?.(diagnosticChannel, onMessage);
    } else {
      const channel = diagch.channel(diagnosticChannel);
      channel.subscribe(onMessage);
      unsubscribe = () => channel.unsubscribe(onMessage);
    }
    this._channelSubs.push({
      name: diagnosticChannel,
      unsubscribe
    });
  }
  parseRequestHeaders(request) {
    const result = /* @__PURE__ */ new Map();
    if (Array.isArray(request.headers)) {
      for (let i = 0; i < request.headers.length; i += 2) {
        const key = request.headers[i];
        const value = request.headers[i + 1];
        if (typeof key === "string" && value !== void 0) {
          result.set(key.toLowerCase(), value);
        }
      }
    } else if (typeof request.headers === "string") {
      const headers = request.headers.split("\r\n");
      for (const line of headers) {
        if (!line) {
          continue;
        }
        const colonIndex = line.indexOf(":");
        if (colonIndex === -1) {
          continue;
        }
        const key = line.substring(0, colonIndex).toLowerCase();
        const value = line.substring(colonIndex + 1).trim();
        const allValues = result.get(key);
        if (allValues && Array.isArray(allValues)) {
          allValues.push(value);
        } else if (allValues) {
          result.set(key, [allValues, value]);
        } else {
          result.set(key, value);
        }
      }
    }
    return result;
  }
  // This is the 1st message we receive for each request (fired after request creation). Here we will
  // create the span and populate some atttributes, then link the span to the request for further
  // span processing
  onRequestCreated({ request }) {
    const config = this._config;
    const enabled = config.enabled !== false;
    const shouldIgnoreReq = safeExecute(
      () => !enabled || request.method === "CONNECT" || config.ignoreRequestHook?.(request),
      (e) => e && DEBUG_BUILD && debug.error("caught ignoreRequestHook error: ", e)
    );
    if (shouldIgnoreReq) {
      return;
    }
    let requestUrl;
    try {
      requestUrl = new URL(request.path, request.origin);
    } catch (err) {
      DEBUG_BUILD && debug.warn("could not determine url.full:", err);
      return;
    }
    const urlScheme = requestUrl.protocol.replace(":", "");
    const requestMethod = this.getRequestMethod(request.method);
    const attributes = {
      [ATTR_HTTP_REQUEST_METHOD]: requestMethod,
      [ATTR_HTTP_REQUEST_METHOD_ORIGINAL]: request.method,
      [ATTR_URL_FULL]: requestUrl.toString(),
      [ATTR_URL_PATH]: requestUrl.pathname,
      [ATTR_URL_QUERY]: requestUrl.search,
      [ATTR_URL_SCHEME]: urlScheme
    };
    const schemePorts = { https: "443", http: "80" };
    const serverAddress = requestUrl.hostname;
    const serverPort = requestUrl.port || schemePorts[urlScheme];
    attributes[ATTR_SERVER_ADDRESS] = serverAddress;
    if (serverPort && !isNaN(Number(serverPort))) {
      attributes[ATTR_SERVER_PORT] = Number(serverPort);
    }
    const headersMap = this.parseRequestHeaders(request);
    const userAgentValues = headersMap.get("user-agent");
    if (userAgentValues) {
      const userAgent = Array.isArray(userAgentValues) ? userAgentValues[userAgentValues.length - 1] : userAgentValues;
      attributes[ATTR_USER_AGENT_ORIGINAL] = userAgent;
    }
    const hookAttributes = safeExecute(
      () => config.startSpanHook?.(request),
      (e) => e && DEBUG_BUILD && debug.error("caught startSpanHook error: ", e)
    );
    if (hookAttributes) {
      Object.entries(hookAttributes).forEach(([key, val]) => {
        attributes[key] = val;
      });
    }
    const span = startInactiveSpan({
      name: requestMethod === "_OTHER" ? "HTTP" : requestMethod,
      kind: SPAN_KIND_CLIENT,
      attributes
    });
    safeExecute(
      () => config.requestHook?.(span, request),
      (e) => e && DEBUG_BUILD && debug.error("caught requestHook error: ", e)
    );
    this.injectTracePropagationHeaders(span, request, requestUrl.toString());
    this._spanFromReq.set(request, span);
  }
  // This is the 2nd message we receive for each request. It is fired when connection with
  // the remote is established and about to send the first byte. Here we do have info about the
  // remote address and port so we can populate some `network.*` attributes into the span
  onRequestHeaders({ request, socket }) {
    const span = this._spanFromReq.get(request);
    if (!span) {
      return;
    }
    const config = this._config;
    const { remoteAddress, remotePort } = socket;
    const spanAttributes = {
      [ATTR_NETWORK_PEER_ADDRESS]: remoteAddress,
      [ATTR_NETWORK_PEER_PORT]: remotePort
    };
    if (config.headersToSpanAttributes?.requestHeaders) {
      const headersToAttribs = new Set(config.headersToSpanAttributes.requestHeaders.map((n) => n.toLowerCase()));
      const headersMap = this.parseRequestHeaders(request);
      for (const [name, value] of headersMap.entries()) {
        if (headersToAttribs.has(name)) {
          const attrValue = Array.isArray(value) ? value : [value];
          spanAttributes[`http.request.header.${name}`] = attrValue;
        }
      }
    }
    span.setAttributes(spanAttributes);
  }
  // This is the 3rd message we get for each request and it's fired when the server
  // headers are received, body may not be accessible yet.
  // From the response headers we can set the status and content length
  onResponseHeaders({ request, response }) {
    const span = this._spanFromReq.get(request);
    if (!span) {
      return;
    }
    const spanAttributes = {
      [ATTR_HTTP_RESPONSE_STATUS_CODE]: response.statusCode
    };
    const config = this._config;
    safeExecute(
      () => config.responseHook?.(span, { request, response }),
      (e) => e && DEBUG_BUILD && debug.error("caught responseHook error: ", e)
    );
    if (config.headersToSpanAttributes?.responseHeaders) {
      const headersToAttribs = /* @__PURE__ */ new Set();
      config.headersToSpanAttributes?.responseHeaders.forEach((name) => headersToAttribs.add(name.toLowerCase()));
      for (let idx = 0; idx < response.headers.length; idx = idx + 2) {
        const nameBuf = response.headers[idx];
        const valueBuf = response.headers[idx + 1];
        if (nameBuf === void 0 || valueBuf === void 0) {
          continue;
        }
        const name = nameBuf.toString().toLowerCase();
        const value = valueBuf;
        if (headersToAttribs.has(name)) {
          const attrName = `http.response.header.${name}`;
          if (!Object.prototype.hasOwnProperty.call(spanAttributes, attrName)) {
            spanAttributes[attrName] = [value.toString()];
          } else {
            spanAttributes[attrName].push(value.toString());
          }
        }
      }
    }
    span.setAttributes(spanAttributes);
    if (response.statusCode >= 400) {
      span.setStatus({ code: SPAN_STATUS_ERROR });
    }
  }
  // This is the last event we receive if the request went without any errors
  onDone({ request }) {
    const span = this._spanFromReq.get(request);
    if (!span) {
      return;
    }
    span.end();
    this._spanFromReq.delete(request);
  }
  // This is the event we get when something is wrong in the request like
  // - invalid options when calling `fetch` global API or any undici method for request
  // - connectivity errors such as unreachable host
  // - requests aborted through an `AbortController.signal`
  // NOTE: server errors are considered valid responses and it's the lib consumer
  // who should deal with that.
  onError({ request, error }) {
    const span = this._spanFromReq.get(request);
    if (!span) {
      return;
    }
    span.setStatus({
      code: SPAN_STATUS_ERROR,
      message: error.message
    });
    span.end();
    this._spanFromReq.delete(request);
  }
  // Propagate the trace data of the given (client) span into the outgoing request headers, gated by
  // `tracePropagationTargets`. Mirrors what `propagation.inject()` did with the SentryPropagator, but
  // via Sentry's `getTraceData()` so we stay off OpenTelemetry's propagation API.
  injectTracePropagationHeaders(span, request, url) {
    const { tracePropagationTargets, propagateTraceparent } = getClient()?.getOptions() ?? {};
    if (!shouldPropagateTraceForUrl(url, tracePropagationTargets, this._propagationDecisionMap)) {
      return;
    }
    const addedHeaders = withActiveSpan(span, () => getTraceData({ propagateTraceparent }));
    const headerEntries = Object.entries(addedHeaders);
    for (let i = 0; i < headerEntries.length; i++) {
      const pair = headerEntries[i];
      if (!pair) {
        continue;
      }
      const [k, v] = pair;
      if (!v) {
        continue;
      }
      if (typeof request.addHeader === "function") {
        request.addHeader(k, v);
      } else if (typeof request.headers === "string") {
        request.headers += `${k}: ${v}\r
`;
      } else if (Array.isArray(request.headers)) {
        request.headers.push(k, v);
      }
    }
  }
  getRequestMethod(original) {
    const knownMethods = {
      CONNECT: true,
      OPTIONS: true,
      HEAD: true,
      GET: true,
      POST: true,
      PUT: true,
      PATCH: true,
      DELETE: true,
      TRACE: true,
      // QUERY from https://datatracker.ietf.org/doc/draft-ietf-httpbis-safe-method-w-body/
      QUERY: true
    };
    if (original.toUpperCase() in knownMethods) {
      return original.toUpperCase();
    }
    return "_OTHER";
  }
}

export { UndiciInstrumentation };
//# sourceMappingURL=undici.js.map
