let path = require("path");
let url = require("url");
//#region src/webpack.ts
var LOADER_PATH = (0, path.resolve)((0, path.dirname)((0, url.fileURLToPath)(require("url").pathToFileURL(__filename).href)), "..", "cjs", "webpack-loader.cjs");
var DIAGNOSTICS_STATE_KEY = "__codeTransformerWebpackDiagnostics";
var CodeTransformerWebpackPlugin = class {
	constructor(options) {
		this.options = options;
	}
	apply(compiler) {
		const webpack = compiler.webpack;
		compiler.options.module = compiler.options.module || { rules: [] };
		compiler.options.module.rules = compiler.options.module.rules || [];
		compiler.options.module.rules.unshift({
			test: /\.(c|m)?jsx?$|\.tsx?$/,
			enforce: "pre",
			use: [{
				loader: LOADER_PATH,
				options: this.options
			}]
		});
		if (this.options.injectDiagnostics) {
			const ConcatSource = webpack?.sources?.ConcatSource;
			if (ConcatSource && webpack?.Compilation) compiler.hooks.thisCompilation.tap("code-transformer", (compilation) => {
				compilation[DIAGNOSTICS_STATE_KEY] = {
					transformedModules: /* @__PURE__ */ new Set(),
					failedModules: /* @__PURE__ */ new Set()
				};
				compilation.hooks.processAssets.tap({
					name: "code-transformer",
					stage: webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE
				}, () => {
					const state = compilation[DIAGNOSTICS_STATE_KEY];
					if (!state) return;
					const injectCode = this.options.injectDiagnostics?.({
						transformedModules: Array.from(state.transformedModules),
						failedModules: Array.from(state.failedModules)
					});
					if (!injectCode) return;
					for (const asset of compilation.getAssets()) {
						if (!/\.(js|ts|jsx|tsx|mjs|cjs)(\?[^?]*)?(#[^#]*)?$/.test(asset.name)) continue;
						compilation.updateAsset(asset.name, (source) => new ConcatSource(injectCode, source));
					}
				});
			});
		}
	}
};
function codeTransformerWebpack(options) {
	return new CodeTransformerWebpackPlugin(options);
}
//#endregion
module.exports = codeTransformerWebpack;

//# sourceMappingURL=webpack.cjs.map