Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const orchestrion = require('@sentry/server-utils/orchestrion');
const register = require('@sentry/server-utils/orchestrion/register');
const diagnosticsChannelInjection = require('./diagnosticsChannelInjection.js');

function experimentalUseDiagnosticsChannelInjection() {
  diagnosticsChannelInjection.setDiagnosticsChannelInjectionLoader(
    () => ({
      integrations: [orchestrion.mysqlChannelIntegration()],
      replacedOtelIntegrationNames: ["Mysql"],
      register: register.registerDiagnosticsChannelInjection,
      detect: orchestrion.detectOrchestrionSetup
    })
  );
}

exports.experimentalUseDiagnosticsChannelInjection = experimentalUseDiagnosticsChannelInjection;
//# sourceMappingURL=experimentalUseDiagnosticsChannelInjection.js.map
