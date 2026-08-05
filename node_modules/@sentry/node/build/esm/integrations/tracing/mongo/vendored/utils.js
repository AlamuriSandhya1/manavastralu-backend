import { SpanKind } from '@opentelemetry/api';
import { getActiveSpan, startInactiveSpan, SPAN_STATUS_ERROR, withActiveSpan, SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN } from '@sentry/core';
import { ATTR_DB_OPERATION, DB_SYSTEM_VALUE_MONGODB, ATTR_NET_PEER_NAME, ATTR_NET_PEER_PORT, ATTR_DB_STATEMENT, ATTR_DB_CONNECTION_STRING, ATTR_DB_MONGODB_COLLECTION, ATTR_DB_NAME, ATTR_DB_SYSTEM } from './semconv.js';
import { MongodbCommandType } from './internal-types.js';

const ORIGIN = "auto.db.otel.mongo";
function serializeDbStatement(commandObj) {
  return JSON.stringify(scrubStatement(commandObj));
}
function scrubStatement(value) {
  if (Array.isArray(value)) {
    return value.map((element) => scrubStatement(element));
  }
  if (isCommandObj(value)) {
    const initial = {};
    return Object.entries(value).map(([key, element]) => [key, scrubStatement(element)]).reduce((prev, current) => {
      if (isCommandEntry(current)) {
        prev[current[0]] = current[1];
      }
      return prev;
    }, initial);
  }
  return "?";
}
function isCommandObj(value) {
  return typeof value === "object" && value !== null && !isBuffer(value);
}
function isBuffer(value) {
  return typeof Buffer !== "undefined" && Buffer.isBuffer(value);
}
function isCommandEntry(value) {
  return Array.isArray(value);
}
function getCommandType(command) {
  if (command.createIndexes !== void 0) {
    return MongodbCommandType.CREATE_INDEXES;
  } else if (command.findandmodify !== void 0) {
    return MongodbCommandType.FIND_AND_MODIFY;
  } else if (command.ismaster !== void 0) {
    return MongodbCommandType.IS_MASTER;
  } else if (command.count !== void 0) {
    return MongodbCommandType.COUNT;
  } else if (command.aggregate !== void 0) {
    return MongodbCommandType.AGGREGATE;
  } else {
    return MongodbCommandType.UNKNOWN;
  }
}
function getV4SpanAttributes(connectionCtx, ns, command, operation) {
  let host, port;
  if (connectionCtx) {
    const hostParts = typeof connectionCtx.address === "string" ? connectionCtx.address.split(":") : "";
    if (hostParts.length === 2) {
      host = hostParts[0];
      port = hostParts[1];
    }
  }
  let commandObj;
  if (command?.documents && command.documents[0]) {
    commandObj = command.documents[0];
  } else if (command?.cursors) {
    commandObj = command.cursors;
  } else {
    commandObj = command;
  }
  return getSpanAttributes(ns.db, ns.collection, host, port, commandObj, operation);
}
function getV3SpanAttributes(ns, topology, command, operation) {
  let host;
  let port;
  if (topology?.s) {
    host = topology.s.options?.host ?? topology.s.host;
    port = (topology.s.options?.port ?? topology.s.port)?.toString();
    if (host == null || port == null) {
      const address = topology.description?.address;
      if (address) {
        const addressSegments = address.split(":");
        host = addressSegments[0];
        port = addressSegments[1];
      }
    }
  }
  const [dbName, dbCollection] = ns.toString().split(".");
  const commandObj = command?.query ?? command?.q ?? command;
  return getSpanAttributes(dbName, dbCollection, host, port, commandObj, operation);
}
function getSpanAttributes(dbName, dbCollection, host, port, commandObj, operation) {
  const attributes = {
    [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: ORIGIN,
    // eslint-disable-next-line typescript/no-deprecated
    [ATTR_DB_SYSTEM]: DB_SYSTEM_VALUE_MONGODB,
    // eslint-disable-next-line typescript/no-deprecated
    [ATTR_DB_NAME]: dbName,
    // eslint-disable-next-line typescript/no-deprecated
    [ATTR_DB_MONGODB_COLLECTION]: dbCollection,
    // eslint-disable-next-line typescript/no-deprecated
    [ATTR_DB_OPERATION]: operation,
    // eslint-disable-next-line typescript/no-deprecated
    [ATTR_DB_CONNECTION_STRING]: `mongodb://${host}:${port}/${dbName}`
  };
  if (host && port) {
    attributes[ATTR_NET_PEER_NAME] = host;
    const portNumber = parseInt(port, 10);
    if (!isNaN(portNumber)) {
      attributes[ATTR_NET_PEER_PORT] = portNumber;
    }
  }
  if (commandObj) {
    try {
      attributes[ATTR_DB_STATEMENT] = serializeDbStatement(commandObj);
    } catch {
    }
  }
  return attributes;
}
function startMongoSpan(attributes) {
  return startInactiveSpan({
    // eslint-disable-next-line typescript/no-deprecated
    name: `mongodb.${attributes[ATTR_DB_OPERATION] || "command"}`,
    kind: SpanKind.CLIENT,
    attributes
  });
}
function patchEnd(span, resultHandler) {
  const parentSpan = getActiveSpan();
  let spanEnded = false;
  return function patchedEnd(...args) {
    if (!spanEnded) {
      spanEnded = true;
      const error = args[0];
      if (span) {
        if (error instanceof Error) {
          span.setStatus({ code: SPAN_STATUS_ERROR, message: error.message });
        }
        span.end();
      }
    }
    return withActiveSpan(parentSpan ?? null, () => resultHandler.apply(this, args));
  };
}
function shouldSkipInstrumentation() {
  return !getActiveSpan();
}

export { getCommandType, getV3SpanAttributes, getV4SpanAttributes, patchEnd, shouldSkipInstrumentation, startMongoSpan };
//# sourceMappingURL=utils.js.map
