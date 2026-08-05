import { detectOrchestrionSetup, mysqlChannelIntegration } from '@sentry/server-utils/orchestrion';
import { registerDiagnosticsChannelInjection } from '@sentry/server-utils/orchestrion/register';
import { setDiagnosticsChannelInjectionLoader } from './diagnosticsChannelInjection.js';

function experimentalUseDiagnosticsChannelInjection() {
  setDiagnosticsChannelInjectionLoader(
    () => ({
      integrations: [mysqlChannelIntegration()],
      replacedOtelIntegrationNames: ["Mysql"],
      register: registerDiagnosticsChannelInjection,
      detect: detectOrchestrionSetup
    })
  );
}

export { experimentalUseDiagnosticsChannelInjection };
//# sourceMappingURL=experimentalUseDiagnosticsChannelInjection.js.map
