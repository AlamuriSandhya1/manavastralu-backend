import { defineIntegration } from '@sentry/core';
import { generateInstrumentOnce } from '@sentry/node-core';
import { FsInstrumentation } from './vendored/instrumentation.js';

const INTEGRATION_NAME = "FileSystem";
const fsIntegration = defineIntegration(
  (options = {}) => {
    return {
      name: INTEGRATION_NAME,
      setupOnce() {
        generateInstrumentOnce(
          INTEGRATION_NAME,
          () => new FsInstrumentation({
            recordFilePaths: options.recordFilePaths,
            recordErrorMessagesAsSpanAttributes: options.recordErrorMessagesAsSpanAttributes
          })
        )();
      }
    };
  }
);

export { fsIntegration };
//# sourceMappingURL=index.js.map
