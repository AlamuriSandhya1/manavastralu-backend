import { DataloaderInstrumentation } from './vendored/instrumentation.js';
import { defineIntegration } from '@sentry/core';
import { generateInstrumentOnce } from '@sentry/node-core';

const INTEGRATION_NAME = "Dataloader";
const instrumentDataloader = generateInstrumentOnce(INTEGRATION_NAME, () => new DataloaderInstrumentation());
const _dataloaderIntegration = (() => {
  return {
    name: INTEGRATION_NAME,
    setupOnce() {
      instrumentDataloader();
    }
  };
});
const dataloaderIntegration = defineIntegration(_dataloaderIntegration);

export { dataloaderIntegration, instrumentDataloader };
//# sourceMappingURL=index.js.map
