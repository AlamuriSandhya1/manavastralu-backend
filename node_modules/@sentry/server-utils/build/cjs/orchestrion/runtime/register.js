Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const core = require('@sentry/core');
const Module = require('node:module');
const node_url = require('node:url');
const debugBuild = require('../../debug-build.js');
const config = require('../config.js');

var _documentCurrentScript = typeof document !== 'undefined' ? document.currentScript : null;
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
  const nodeRequire = typeof require === "function" ? require : Module.createRequire((typeof document === 'undefined' ? require('u' + 'rl').pathToFileURL(__filename).href : (_documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === 'SCRIPT' && _documentCurrentScript.src || new URL('orchestrion/runtime/register.js', document.baseURI).href)));
  const mod = Module;
  try {
    if (typeof mod.registerHooks === "function" && stableSyncHooks) {
      const { initialize, resolve, load } = nodeRequire("@apm-js-collab/tracing-hooks/hook-sync.mjs");
      initialize({ instrumentations: config.SENTRY_INSTRUMENTATIONS });
      mod.registerHooks({ resolve, load });
      debugBuild.DEBUG_BUILD && core.debug.log("[orchestrion] registered diagnostics-channel injection via Module.registerHooks()");
    } else if (typeof mod.register === "function" && !globalAny.Bun && !globalAny.Deno) {
      mod.register(node_url.pathToFileURL(nodeRequire.resolve("@apm-js-collab/tracing-hooks/hook.mjs")).href, {
        data: { instrumentations: config.SENTRY_INSTRUMENTATIONS }
      });
      const ModulePatch = nodeRequire("@apm-js-collab/tracing-hooks");
      new ModulePatch({ instrumentations: config.SENTRY_INSTRUMENTATIONS }).patch();
      debugBuild.DEBUG_BUILD && core.debug.log("[orchestrion] registered diagnostics-channel injection via Module.register()");
    } else {
      debugBuild.DEBUG_BUILD && core.debug.warn("[Sentry] No available Node API to register diagnostics-channel injection hooks; skipping.");
      return;
    }
  } catch (error) {
    debugBuild.DEBUG_BUILD && core.debug.warn(
      "[Sentry] Failed to register diagnostics-channel injection hooks; channel-based integrations will not record spans.",
      error
    );
    return;
  }
  g.runtime = true;
}

exports.registerDiagnosticsChannelInjection = registerDiagnosticsChannelInjection;
//# sourceMappingURL=register.js.map
