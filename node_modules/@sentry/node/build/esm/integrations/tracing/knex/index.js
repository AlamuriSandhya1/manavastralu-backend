import { KnexInstrumentation } from './vendored/instrumentation.js';
import { defineIntegration } from '@sentry/core';
import { generateInstrumentOnce } from '@sentry/node-core';

const INTEGRATION_NAME = "Knex";
const instrumentKnex = generateInstrumentOnce(INTEGRATION_NAME, () => new KnexInstrumentation());
const _knexIntegration = (() => {
  return {
    name: INTEGRATION_NAME,
    setupOnce() {
      instrumentKnex();
    }
  };
});
const knexIntegration = defineIntegration(_knexIntegration);

export { instrumentKnex, knexIntegration };
//# sourceMappingURL=index.js.map
