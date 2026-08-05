import codeTransformer from '@apm-js-collab/code-transformer-bundler-plugins/vite';
import MagicString from 'magic-string';
import { SENTRY_INSTRUMENTATIONS, INSTRUMENTED_MODULE_NAMES } from '../config.js';

function sentryOrchestrionPlugin() {
  const codeTransformerPlugins = codeTransformer({ instrumentations: SENTRY_INSTRUMENTATIONS });
  const codeTransformerArray = Array.isArray(codeTransformerPlugins) ? codeTransformerPlugins : [codeTransformerPlugins];
  return [bundlerMarkerPlugin(), ...codeTransformerArray];
}
function bundlerMarkerPlugin() {
  const banner = [
    "globalThis.__SENTRY_ORCHESTRION__ = (globalThis.__SENTRY_ORCHESTRION__ || {});",
    "globalThis.__SENTRY_ORCHESTRION__.bundler = true;",
    ""
  ].join("\n");
  return {
    name: "sentry-orchestrion-marker",
    enforce: "pre",
    config() {
      return { ssr: { noExternal: INSTRUMENTED_MODULE_NAMES } };
    },
    renderChunk(code, chunk) {
      if (!chunk.isEntry) return null;
      const ms = new MagicString(code);
      ms.prepend(banner);
      return { code: ms.toString(), map: ms.generateMap({ hires: true }) };
    }
  };
}

export { sentryOrchestrionPlugin };
//# sourceMappingURL=vite.js.map
