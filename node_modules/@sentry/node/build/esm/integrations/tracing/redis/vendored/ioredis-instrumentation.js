import { SpanKind } from '@opentelemetry/api';
import { InstrumentationBase, InstrumentationNodeModuleDefinition, isWrapped } from '@opentelemetry/instrumentation';
import { SDK_VERSION, getActiveSpan, startInactiveSpan, SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN, SPAN_STATUS_ERROR } from '@sentry/core';
import { defaultDbStatementSerializer } from './redis-common.js';
import { ATTR_DB_STATEMENT, DB_SYSTEM_VALUE_REDIS, ATTR_NET_PEER_PORT, ATTR_NET_PEER_NAME, ATTR_DB_CONNECTION_STRING, ATTR_DB_SYSTEM } from './semconv.js';

const PACKAGE_NAME = "@sentry/instrumentation-ioredis";
const ORIGIN = "auto.db.otel.redis";
const SUPPORTED_VERSIONS = [">=2.0.0 <5.11.0"];
function endSpan(span, err) {
  if (err) {
    span.setStatus({ code: SPAN_STATUS_ERROR, message: err.message });
  }
  span.end();
}
class IORedisInstrumentation extends InstrumentationBase {
  constructor(config = {}) {
    super(PACKAGE_NAME, SDK_VERSION, config);
  }
  init() {
    return [
      new InstrumentationNodeModuleDefinition(
        "ioredis",
        SUPPORTED_VERSIONS,
        (module) => {
          const moduleExports = module[Symbol.toStringTag] === "Module" && module.default ? module.default : module;
          if (isWrapped(moduleExports.prototype.sendCommand)) {
            this._unwrap(moduleExports.prototype, "sendCommand");
          }
          this._wrap(moduleExports.prototype, "sendCommand", this._patchSendCommand());
          if (isWrapped(moduleExports.prototype.connect)) {
            this._unwrap(moduleExports.prototype, "connect");
          }
          this._wrap(moduleExports.prototype, "connect", this._patchConnection());
          return module;
        },
        (module) => {
          if (module === void 0) return;
          const moduleExports = module[Symbol.toStringTag] === "Module" && module.default ? module.default : module;
          this._unwrap(moduleExports.prototype, "sendCommand");
          this._unwrap(moduleExports.prototype, "connect");
        }
      )
    ];
  }
  _patchSendCommand() {
    const instrumentation = this;
    return (original) => {
      return function(...args) {
        const cmd = args[0];
        if (args.length < 1 || typeof cmd !== "object" || !getActiveSpan()) {
          return original.apply(this, args);
        }
        const { host, port } = this.options;
        const attributes = {
          [ATTR_DB_SYSTEM]: DB_SYSTEM_VALUE_REDIS,
          [ATTR_DB_STATEMENT]: defaultDbStatementSerializer(cmd.name, cmd.args),
          [ATTR_DB_CONNECTION_STRING]: `redis://${host}:${port}`,
          [ATTR_NET_PEER_NAME]: host,
          [ATTR_NET_PEER_PORT]: port,
          [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: ORIGIN
        };
        const span = startInactiveSpan({ name: cmd.name, kind: SpanKind.CLIENT, attributes });
        try {
          const result = original.apply(this, args);
          const origResolve = cmd.resolve;
          cmd.resolve = function(response) {
            instrumentation._callResponseHook(span, cmd, response);
            endSpan(span, null);
            origResolve(response);
          };
          const origReject = cmd.reject;
          cmd.reject = function(err) {
            endSpan(span, err);
            origReject(err);
          };
          return result;
        } catch (error) {
          endSpan(span, error);
          throw error;
        }
      };
    };
  }
  _patchConnection() {
    return (original) => {
      return function(...args) {
        if (!getActiveSpan()) {
          return original.apply(this, args);
        }
        const { host, port } = this.options;
        const attributes = {
          [ATTR_DB_SYSTEM]: DB_SYSTEM_VALUE_REDIS,
          [ATTR_DB_STATEMENT]: "connect",
          [ATTR_DB_CONNECTION_STRING]: `redis://${host}:${port}`,
          [ATTR_NET_PEER_NAME]: host,
          [ATTR_NET_PEER_PORT]: port,
          [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: ORIGIN
        };
        const span = startInactiveSpan({ name: "connect", kind: SpanKind.CLIENT, attributes });
        try {
          const result = original.apply(this, args);
          if (result instanceof Promise) {
            return result.then(
              (value) => {
                endSpan(span, null);
                return value;
              },
              (error) => {
                endSpan(span, error);
                return Promise.reject(error);
              }
            );
          }
          endSpan(span, null);
          return result;
        } catch (error) {
          endSpan(span, error);
          throw error;
        }
      };
    };
  }
  _callResponseHook(span, cmd, response) {
    const { responseHook } = this.getConfig();
    if (!responseHook) {
      return;
    }
    try {
      responseHook(span, cmd.name, cmd.args, response);
    } catch {
    }
  }
}

export { IORedisInstrumentation };
//# sourceMappingURL=ioredis-instrumentation.js.map
