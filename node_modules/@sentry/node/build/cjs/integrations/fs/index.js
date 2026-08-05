Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const core = require('@sentry/core');
const nodeCore = require('@sentry/node-core');
const instrumentation = require('./vendored/instrumentation.js');

const INTEGRATION_NAME = "FileSystem";
const fsIntegration = core.defineIntegration(
  (options = {}) => {
    return {
      name: INTEGRATION_NAME,
      setupOnce() {
        nodeCore.generateInstrumentOnce(
          INTEGRATION_NAME,
          () => new instrumentation.FsInstrumentation({
            recordFilePaths: options.recordFilePaths,
            recordErrorMessagesAsSpanAttributes: options.recordErrorMessagesAsSpanAttributes
          })
        )();
      }
    };
  }
);

exports.fsIntegration = fsIntegration;
//# sourceMappingURL=index.js.map
