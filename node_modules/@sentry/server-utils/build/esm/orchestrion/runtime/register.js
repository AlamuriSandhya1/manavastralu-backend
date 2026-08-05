import { debug } from '@sentry/core';
import * as Module from 'node:module';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DEBUG_BUILD } from '../../debug-build.js';
import { SENTRY_INSTRUMENTATIONS } from '../config.js';

function registerDiagnosticsChannelInjection() {
  const g = globalThis.__SENTRY_ORCHESTRION__ ?? (globalThis.__SENTRY_ORCHESTRION__ = {});
  if (g.runtime || g.bundler) {
    return;
  }
  const globalAny = globalThis;
  const parseVersion = (v) => v.split(".").map((n) => parseInt(n, 10));
  const nodeVersion = parseVersion(process.versions.node ?? "0.0.0");
  const denoVersion = parseVersion(globalAny.Deno?.version?.deno ?? "0.0.0");
  const stableSyncHooks = (nodeVersion[0] ?? 0) > 25 || nodeVersion[0] === 25 && (nodeVersion[1] ?? 0) >= 1 || nodeVersion[0] === 24 && (nodeVersion[1] ?? 0) >= 13 || (denoVersion[0] ?? 0) > 2 || denoVersion[0] === 2 && (denoVersion[1] ?? 0) >= 8;
  const nodeRequire = typeof require === "function" ? require : createRequire(import.meta.url);
  const mod = Module;
  try {
    if (typeof mod.registerHooks === "function" && stableSyncHooks) {
      const { initialize, resolve, load } = nodeRequire("@apm-js-collab/tracing-hooks/hook-sync.mjs");
      initialize({ instrumentations: SENTRY_INSTRUMENTATIONS });
      mod.registerHooks({ resolve, load });
      DEBUG_BUILD && debug.log("[orchestrion] registered diagnostics-channel injection via Module.registerHooks()");
    } else if (typeof mod.register === "function" && !globalAny.Bun && !globalAny.Deno) {
      mod.register(pathToFileURL(nodeRequire.resolve("@apm-js-collab/tracing-hooks/hook.mjs")).href, {
        data: { instrumentations: SENTRY_INSTRUMENTATIONS }
      });
      const ModulePatch = nodeRequire("@apm-js-collab/tracing-hooks");
      new ModulePatch({ instrumentations: SENTRY_INSTRUMENTATIONS }).patch();
      DEBUG_BUILD && debug.log("[orchestrion] registered diagnostics-channel injection via Module.register()");
    } else {
      DEBUG_BUILD && debug.warn("[Sentry] No available Node API to register diagnostics-channel injection hooks; skipping.");
      return;
    }
  } catch (error) {
    DEBUG_BUILD && debug.warn(
      "[Sentry] Failed to register diagnostics-channel injection hooks; channel-based integrations will not record spans.",
      error
    );
    return;
  }
  g.runtime = true;
}

export { registerDiagnosticsChannelInjection };
//# sourceMappingURL=register.js.map
