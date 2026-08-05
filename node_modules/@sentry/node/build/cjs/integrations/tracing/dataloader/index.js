Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const instrumentation = require('./vendored/instrumentation.js');
const core = require('@sentry/core');
const nodeCore = require('@sentry/node-core');

const INTEGRATION_NAME = "Dataloader";
const instrumentDataloader = nodeCore.generateInstrumentOnce(INTEGRATION_NAME, () => new instrumentation.DataloaderInstrumentation());
const _dataloaderIntegration = (() => {
  return {
    name: INTEGRATION_NAME,
    setupOnce() {
      instrumentDataloader();
    }
  };
});
const dataloaderIntegration = core.defineIntegration(_dataloaderIntegration);

exports.dataloaderIntegration = dataloaderIntegration;
exports.instrumentDataloader = instrumentDataloader;
//# sourceMappingURL=index.js.map
