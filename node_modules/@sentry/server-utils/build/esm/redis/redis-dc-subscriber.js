import { SERVER_PORT, SERVER_ADDRESS, DB_QUERY_TEXT, DB_SYSTEM_NAME, DB_OPERATION_BATCH_SIZE } from '@sentry/conventions/attributes';
import { debug, startSpanManual, SEMANTIC_ATTRIBUTE_SENTRY_OP, SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN, SPAN_STATUS_ERROR } from '@sentry/core';
import { DEBUG_BUILD } from '../debug-build.js';

const REDIS_DC_CHANNEL_COMMAND = "node-redis:command";
const REDIS_DC_CHANNEL_BATCH = "node-redis:batch";
const REDIS_DC_CHANNEL_CONNECT = "node-redis:connect";
const IOREDIS_DC_CHANNEL_COMMAND = "ioredis:command";
const IOREDIS_DC_CHANNEL_CONNECT = "ioredis:connect";
const ORIGIN = "auto.db.redis.diagnostic_channel";
const DB_SYSTEM_NAME_VALUE_REDIS = "redis";
const NOOP = () => {
};
let subscribed = false;
let currentResponseHook;
function subscribeRedisDiagnosticChannels(tracingChannel, responseHook) {
  currentResponseHook = responseHook;
  if (subscribed) return;
  subscribed = true;
  try {
    setupCommandChannel(tracingChannel, REDIS_DC_CHANNEL_COMMAND, (data) => data.args.slice(1));
    setupBatchChannel(
      tracingChannel,
      REDIS_DC_CHANNEL_BATCH,
      (data) => data.batchMode === "PIPELINE" ? "PIPELINE" : "MULTI"
    );
    setupConnectChannel(tracingChannel, REDIS_DC_CHANNEL_CONNECT);
    setupCommandChannel(tracingChannel, IOREDIS_DC_CHANNEL_COMMAND, (data) => data.args);
    setupConnectChannel(tracingChannel, IOREDIS_DC_CHANNEL_CONNECT);
  } catch {
    DEBUG_BUILD && debug.log("Redis node:diagnostics_channel subscription failed.");
  }
}
function setupCommandChannel(tracingChannel, channelName, getCommandArgs) {
  const channel = tracingChannel(channelName, (data) => {
    const args = getCommandArgs(data);
    const statement = args.length ? `${data.command} ${args.join(" ")}` : data.command;
    return startSpanManual(
      {
        name: `redis-${data.command}`,
        attributes: {
          [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: ORIGIN,
          [SEMANTIC_ATTRIBUTE_SENTRY_OP]: "db.redis",
          [DB_SYSTEM_NAME]: DB_SYSTEM_NAME_VALUE_REDIS,
          [DB_QUERY_TEXT]: statement,
          ...data.serverAddress != null ? { [SERVER_ADDRESS]: data.serverAddress } : {},
          ...data.serverPort != null ? { [SERVER_PORT]: data.serverPort } : {}
        }
      },
      (span) => span
    );
  });
  channel.subscribe({
    start: NOOP,
    asyncStart: NOOP,
    end: NOOP,
    asyncEnd: (data) => {
      const span = data._sentrySpan;
      if (!span || data.error) return;
      runResponseHook(span, data.command, getCommandArgs(data), data.result);
      span.end();
    },
    error: (data) => {
      const span = data._sentrySpan;
      if (!span) return;
      if (data.error) {
        span.setStatus({ code: SPAN_STATUS_ERROR, message: data.error.message });
      }
      span.end();
    }
  });
}
function setupBatchChannel(tracingChannel, channelName, getOperationName) {
  const channel = tracingChannel(channelName, (data) => {
    return startSpanManual(
      {
        name: getOperationName(data),
        attributes: {
          [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: ORIGIN,
          [SEMANTIC_ATTRIBUTE_SENTRY_OP]: "db.redis",
          [DB_SYSTEM_NAME]: DB_SYSTEM_NAME_VALUE_REDIS,
          // should only include batch size greater than 1,
          // or else it isn't properly considered a "batch"
          ...Number(data.batchSize) > 1 ? { [DB_OPERATION_BATCH_SIZE]: data.batchSize } : {},
          ...data.serverAddress != null ? { [SERVER_ADDRESS]: data.serverAddress } : {},
          ...data.serverPort != null ? { [SERVER_PORT]: data.serverPort } : {}
        }
      },
      (span) => span
    );
  });
  channel.subscribe({
    start: NOOP,
    asyncStart: NOOP,
    end: NOOP,
    asyncEnd: (data) => {
      if (!data.error) data._sentrySpan?.end();
    },
    error: (data) => {
      const span = data._sentrySpan;
      if (!span) return;
      if (data.error) {
        span.setStatus({ code: SPAN_STATUS_ERROR, message: data.error.message });
      }
      span.end();
    }
  });
}
function setupConnectChannel(tracingChannel, channelName) {
  const channel = tracingChannel(channelName, (data) => {
    return startSpanManual(
      {
        name: "redis-connect",
        attributes: {
          [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: ORIGIN,
          [SEMANTIC_ATTRIBUTE_SENTRY_OP]: "db.redis.connect",
          [DB_SYSTEM_NAME]: DB_SYSTEM_NAME_VALUE_REDIS,
          ...data.serverAddress != null ? { [SERVER_ADDRESS]: data.serverAddress } : {},
          ...data.serverPort != null ? { [SERVER_PORT]: data.serverPort } : {}
        }
      },
      (span) => span
    );
  });
  channel.subscribe({
    start: NOOP,
    asyncStart: NOOP,
    end: NOOP,
    asyncEnd: (data) => {
      if (!data.error) data._sentrySpan?.end();
    },
    error: (data) => {
      const span = data._sentrySpan;
      if (!span) return;
      if (data.error) {
        span.setStatus({ code: SPAN_STATUS_ERROR, message: data.error.message });
      }
      span.end();
    }
  });
}
function runResponseHook(span, command, args, result) {
  const hook = currentResponseHook;
  if (!hook) return;
  try {
    hook(span, command, args, result);
  } catch {
  }
}

export { IOREDIS_DC_CHANNEL_COMMAND, IOREDIS_DC_CHANNEL_CONNECT, REDIS_DC_CHANNEL_BATCH, REDIS_DC_CHANNEL_COMMAND, REDIS_DC_CHANNEL_CONNECT, subscribeRedisDiagnosticChannels };
//# sourceMappingURL=redis-dc-subscriber.js.map
