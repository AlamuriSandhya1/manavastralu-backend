import { SpanKind, TraceFlags } from '@opentelemetry/api';
import { startInactiveSpan, SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN, SPAN_STATUS_ERROR, propagationContextFromHeaders, getTraceData } from '@sentry/core';
import { MESSAGING_SYSTEM_VALUE_KAFKA, ATTR_MESSAGING_KAFKA_OFFSET, ATTR_MESSAGING_KAFKA_MESSAGE_TOMBSTONE, ATTR_MESSAGING_KAFKA_MESSAGE_KEY, ATTR_MESSAGING_OPERATION_NAME, ATTR_MESSAGING_OPERATION_TYPE, ATTR_MESSAGING_DESTINATION_NAME, ATTR_MESSAGING_SYSTEM, MESSAGING_OPERATION_TYPE_VALUE_RECEIVE, ATTR_ERROR_TYPE, ERROR_TYPE_VALUE_OTHER, MESSAGING_OPERATION_TYPE_VALUE_SEND, ATTR_MESSAGING_DESTINATION_PARTITION_ID } from './semconv.js';

const PRODUCER_ORIGIN = "auto.kafkajs.otel.producer";
const CONSUMER_ORIGIN = "auto.kafkajs.otel.consumer";
function getHeaderAsString(headers, key) {
  const value = headers?.[key];
  if (value == null) {
    return void 0;
  }
  return Array.isArray(value) ? value[0]?.toString() : value.toString();
}
function getLinksFromHeaders(headers) {
  const sentryTrace = getHeaderAsString(headers, "sentry-trace");
  if (!sentryTrace) {
    return void 0;
  }
  const { traceId, parentSpanId, sampled } = propagationContextFromHeaders(
    sentryTrace,
    getHeaderAsString(headers, "baggage")
  );
  if (!parentSpanId) {
    return void 0;
  }
  return [
    {
      context: {
        traceId,
        spanId: parentSpanId,
        isRemote: true,
        traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE
      }
    }
  ];
}
function startConsumerSpan({ topic, message, operationType, links, attributes }) {
  const operationName = operationType === MESSAGING_OPERATION_TYPE_VALUE_RECEIVE ? "poll" : operationType;
  return startInactiveSpan({
    name: `${operationName} ${topic}`,
    kind: operationType === MESSAGING_OPERATION_TYPE_VALUE_RECEIVE ? SpanKind.CLIENT : SpanKind.CONSUMER,
    links,
    attributes: {
      ...attributes,
      [ATTR_MESSAGING_SYSTEM]: MESSAGING_SYSTEM_VALUE_KAFKA,
      [ATTR_MESSAGING_DESTINATION_NAME]: topic,
      [ATTR_MESSAGING_OPERATION_TYPE]: operationType,
      [ATTR_MESSAGING_OPERATION_NAME]: operationName,
      [ATTR_MESSAGING_KAFKA_MESSAGE_KEY]: message?.key ? String(message.key) : void 0,
      [ATTR_MESSAGING_KAFKA_MESSAGE_TOMBSTONE]: message?.key && message.value === null ? true : void 0,
      [ATTR_MESSAGING_KAFKA_OFFSET]: message?.offset,
      // Mirror the upstream behavior of only tagging per-message processing spans (not the batch
      // receiving span, which carries no message) with the auto origin.
      ...message ? { [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: CONSUMER_ORIGIN } : {}
    }
  });
}
function startProducerSpan(topic, message) {
  const span = startInactiveSpan({
    name: `send ${topic}`,
    kind: SpanKind.PRODUCER,
    attributes: {
      [ATTR_MESSAGING_SYSTEM]: MESSAGING_SYSTEM_VALUE_KAFKA,
      [ATTR_MESSAGING_DESTINATION_NAME]: topic,
      [ATTR_MESSAGING_KAFKA_MESSAGE_KEY]: message.key ? String(message.key) : void 0,
      [ATTR_MESSAGING_KAFKA_MESSAGE_TOMBSTONE]: message.key && message.value === null ? true : void 0,
      [ATTR_MESSAGING_DESTINATION_PARTITION_ID]: message.partition !== void 0 ? String(message.partition) : void 0,
      [ATTR_MESSAGING_OPERATION_NAME]: "send",
      [ATTR_MESSAGING_OPERATION_TYPE]: MESSAGING_OPERATION_TYPE_VALUE_SEND,
      [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: PRODUCER_ORIGIN
    }
  });
  message.headers = message.headers ?? {};
  const traceData = getTraceData({ span });
  if (traceData["sentry-trace"]) {
    message.headers["sentry-trace"] = traceData["sentry-trace"];
  }
  if (traceData.baggage) {
    message.headers["baggage"] = traceData.baggage;
  }
  return span;
}
function endSpansOnPromise(spans, sendPromise) {
  return Promise.resolve(sendPromise).catch((reason) => {
    let errorMessage;
    let errorType = ERROR_TYPE_VALUE_OTHER;
    if (typeof reason === "string" || reason === void 0) {
      errorMessage = reason;
    } else if (typeof reason === "object" && Object.prototype.hasOwnProperty.call(reason, "message")) {
      errorMessage = reason.message;
      errorType = reason.constructor.name;
    }
    spans.forEach((span) => {
      span.setAttribute(ATTR_ERROR_TYPE, errorType);
      span.setStatus({
        code: SPAN_STATUS_ERROR,
        message: errorMessage
      });
    });
    throw reason;
  }).finally(() => {
    spans.forEach((span) => span.end());
  });
}

export { endSpansOnPromise, getHeaderAsString, getLinksFromHeaders, startConsumerSpan, startProducerSpan };
//# sourceMappingURL=utils.js.map
