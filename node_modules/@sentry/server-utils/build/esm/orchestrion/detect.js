import { debug } from '@sentry/core';
import { DEBUG_BUILD } from '../debug-build.js';

function detectOrchestrionSetup() {
  if (!DEBUG_BUILD) return;
  const marker = globalThis.__SENTRY_ORCHESTRION__;
  const runtime = !!marker?.runtime;
  const bundler = !!marker?.bundler;
  DEBUG_BUILD && debug.log(`[orchestrion] detect: runtime=${runtime} bundler=${bundler}`);
  if (!runtime && !bundler) {
    DEBUG_BUILD && debug.warn(
      "[Sentry] No diagnostics-channel injection detected. Channel-based integrations (mysql, \u2026) will not record spans. Make sure the diagnostics channels are injected via the runtime `--import` hook or a bundler plugin before the instrumented modules load."
    );
  }
}

export { detectOrchestrionSetup };
//# sourceMappingURL=detect.js.map
