Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const SENTRY_INSTRUMENTATIONS = [
  {
    channelName: "query",
    module: { name: "mysql", versionRange: ">=2.0.0 <3", filePath: "lib/Connection.js" },
    // `Connection` in mysql v2 is a constructor function (NOT a class):
    //   `function Connection(options) { ... }`
    //   `Connection.prototype.query = function query(sql, values, cb) { ... }`
    // orchestrion's `className`+`methodName` query only matches `class` declarations.
    // The named function expression on the right-hand side of the prototype
    // assignment is what we want — that's matched by `expressionName: 'query'`,
    // which produces the esquery selector
    //   `AssignmentExpression[left.property.name="query"] > FunctionExpression[async]`.
    // `Auto` so both `connection.query(sql, cb)` and `connection.query(sql)`
    // (streamable, no callback) get channel events. The transform picks
    // `wrapCallback` when the last arg is a function and `wrapPromise`
    // otherwise — for mysql's no-callback path the latter publishes
    // `start`/`end` synchronously around the original call and stores the
    // returned `Query` emitter on `ctx.result`, which the integration uses to
    // attach `'end'`/`'error'` listeners that finish the span.
    functionQuery: { expressionName: "query", kind: "Auto" }
  }
];
const INSTRUMENTED_MODULE_NAMES = Array.from(new Set(SENTRY_INSTRUMENTATIONS.map((i) => i.module.name)));
function withoutInstrumentedExternals(external) {
  if (!external) {
    return void 0;
  }
  return external.filter(
    (entry) => !INSTRUMENTED_MODULE_NAMES.some((name) => entry === name || entry.startsWith(`${name}/`))
  );
}

exports.INSTRUMENTED_MODULE_NAMES = INSTRUMENTED_MODULE_NAMES;
exports.SENTRY_INSTRUMENTATIONS = SENTRY_INSTRUMENTATIONS;
exports.withoutInstrumentedExternals = withoutInstrumentedExternals;
//# sourceMappingURL=config.js.map
