Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const core = require('@sentry/core');
const debugBuild = require('../debug-build.js');

function detectOrchestrionSetup() {
  if (!debugBuild.DEBUG_BUILD) return;
  const marker = globalThis.__SENTRY_ORCHESTRION__;
  const runtime = !!marker?.runtime;
  const bundler = !!marker?.bundler;
  debugBuild.DEBUG_BUILD && core.debug.log(`[orchestrion] detect: runtime=${runtime} bundler=${bundler}`);
  if (!runtime && !bundler) {
    debugBuild.DEBUG_BUILD && core.debug.warn(
      "[Sentry] No diagnostics-channel injection detected. Channel-based integrations (mysql, \u2026) will not record spans. Make sure the diagnostics channels are injected via the runtime `--import` hook or a bundler plugin before the instrumented modules load."
    );
  }
}

exports.detectOrchestrionSetup = detectOrchestrionSetup;
//# sourceMappingURL=detect.js.map
