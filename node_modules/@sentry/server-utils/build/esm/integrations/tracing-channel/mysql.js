import * as diagnosticsChannel from 'node:diagnostics_channel';
import { defineIntegration, debug, SPAN_STATUS_ERROR, startInactiveSpan, SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN, getActiveSpan, withActiveSpan } from '@sentry/core';
import { DEBUG_BUILD } from '../../debug-build.js';
import { CHANNELS } from '../../orchestrion/channels.js';

const INTEGRATION_NAME = "Mysql";
const ATTR_DB_SYSTEM = "db.system";
const ATTR_DB_CONNECTION_STRING = "db.connection_string";
const ATTR_DB_NAME = "db.name";
const ATTR_DB_USER = "db.user";
const ATTR_DB_STATEMENT = "db.statement";
const ATTR_NET_PEER_NAME = "net.peer.name";
const ATTR_NET_PEER_PORT = "net.peer.port";
const _mysqlChannelIntegration = (() => {
  return {
    name: INTEGRATION_NAME,
    setupOnce() {
      DEBUG_BUILD && debug.log(`[orchestrion:mysql] subscribing to channel "${CHANNELS.MYSQL_QUERY}"`);
      const queryCh = diagnosticsChannel.tracingChannel(CHANNELS.MYSQL_QUERY);
      const spans = /* @__PURE__ */ new WeakMap();
      queryCh.subscribe({
        start(rawCtx) {
          const ctx = rawCtx;
          const sql = extractSql(ctx.arguments[0]);
          const { host, port, database, user } = getConnectionConfig(ctx.self);
          const portNumber = typeof port === "string" ? parseInt(port, 10) : port;
          const portIsNumber = typeof portNumber === "number" && !isNaN(portNumber);
          const span = startInactiveSpan({
            name: sql ?? "mysql.query",
            op: "db",
            attributes: {
              [ATTR_DB_SYSTEM]: "mysql",
              [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: "auto.db.orchestrion.mysql",
              [ATTR_DB_CONNECTION_STRING]: getJDBCString(host, portIsNumber ? portNumber : void 0, database),
              ...database ? { [ATTR_DB_NAME]: database } : {},
              ...user ? { [ATTR_DB_USER]: user } : {},
              ...sql ? { [ATTR_DB_STATEMENT]: sql } : {},
              ...host ? { [ATTR_NET_PEER_NAME]: host } : {},
              ...portIsNumber ? { [ATTR_NET_PEER_PORT]: portNumber } : {}
            }
          });
          spans.set(rawCtx, span);
          const parentSpan = getActiveSpan();
          if (parentSpan && ctx.arguments.length > 0) {
            const cbIdx = ctx.arguments.length - 1;
            const orchestrionWrappedCb = ctx.arguments[cbIdx];
            if (typeof orchestrionWrappedCb === "function") {
              const wrapped = orchestrionWrappedCb;
              ctx.arguments[cbIdx] = function(...args) {
                return withActiveSpan(parentSpan, () => wrapped.apply(this, args));
              };
            }
          }
        },
        end(rawCtx) {
          const ctx = rawCtx;
          if (ctx.error !== void 0) {
            finishSpan(rawCtx);
            return;
          }
          const result = ctx.result;
          if (result && typeof result === "object" && hasOnMethod(result)) {
            const span = spans.get(rawCtx);
            if (!span) return;
            result.on("error", (err) => {
              span.setStatus({
                code: SPAN_STATUS_ERROR,
                message: err instanceof Error ? err.message : "unknown_error"
              });
              finishSpan(rawCtx);
            });
            result.on("end", () => finishSpan(rawCtx));
            return;
          }
        },
        error(rawCtx) {
          const ctx = rawCtx;
          const span = spans.get(rawCtx);
          if (!span) return;
          span.setStatus({
            code: SPAN_STATUS_ERROR,
            message: ctx.error instanceof Error ? ctx.error.message : "unknown_error"
          });
        },
        asyncStart() {
        },
        asyncEnd(rawCtx) {
          finishSpan(rawCtx);
        }
      });
      function finishSpan(rawCtx) {
        const span = spans.get(rawCtx);
        if (!span) return;
        span.end();
        spans.delete(rawCtx);
      }
    }
  };
});
function hasOnMethod(obj) {
  return "on" in obj && typeof obj.on === "function";
}
function extractSql(firstArg) {
  if (typeof firstArg === "string") {
    return firstArg;
  }
  if (firstArg && typeof firstArg === "object" && "sql" in firstArg) {
    const sql = firstArg.sql;
    return typeof sql === "string" ? sql : void 0;
  }
  return void 0;
}
function getConnectionConfig(connection) {
  const config = connection?.config?.connectionConfig ?? connection?.config ?? {};
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user
  };
}
function getJDBCString(host, port, database) {
  let s = `jdbc:mysql://${host || "localhost"}`;
  if (typeof port === "number") {
    s += `:${port}`;
  }
  if (database) {
    s += `/${database}`;
  }
  return s;
}
const mysqlChannelIntegration = defineIntegration(_mysqlChannelIntegration);

export { mysqlChannelIntegration };
//# sourceMappingURL=mysql.js.map
