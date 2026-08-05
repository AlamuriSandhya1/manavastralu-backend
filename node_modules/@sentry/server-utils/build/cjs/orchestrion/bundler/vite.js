Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const codeTransformer = require('@apm-js-collab/code-transformer-bundler-plugins/vite');
const MagicString = require('magic-string');
const config = require('../config.js');

function sentryOrchestrionPlugin() {
  const codeTransformerPlugins = codeTransformer.default({ instrumentations: config.SENTRY_INSTRUMENTATIONS });
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
      return { ssr: { noExternal: config.INSTRUMENTED_MODULE_NAMES } };
    },
    renderChunk(code, chunk) {
      if (!chunk.isEntry) return null;
      const ms = new MagicString.default(code);
      ms.prepend(banner);
      return { code: ms.toString(), map: ms.generateMap({ hires: true }) };
    }
  };
}

exports.sentryOrchestrionPlugin = sentryOrchestrionPlugin;
//# sourceMappingURL=vite.js.map
