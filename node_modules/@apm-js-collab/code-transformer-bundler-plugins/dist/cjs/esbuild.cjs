const require_core = require("./core-BOrUDYbE.cjs");
let fs = require("fs");
//#region src/esbuild.ts
var filter = /\.(cjs|mjs|cts|mts|tsx|jsx|ts|js)$/;
function shouldInjectOutput(path) {
	return path === "<stdout>" || require_core.isJsFile(path);
}
function codeTransformerEsbuild(options) {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	return {
		name: "code-transformer",
		setup(build) {
			let transformer;
			build.onStart(() => {
				transformer = require_core.createCodeTransformer(options);
			});
			build.onLoad({ filter }, (args) => {
				const code = (0, fs.readFileSync)(args.path, "utf8");
				const result = transformer.transform(code, args.path);
				if (!result) return null;
				return {
					contents: result.code,
					loader: "default"
				};
			});
			if (!options.injectDiagnostics) return;
			if (build.initialOptions.write !== false) build.initialOptions.metafile = true;
			build.onEnd((result) => {
				if (result.errors.length > 0) return;
				const injectCodeRaw = transformer.getCodeToInject();
				if (!injectCodeRaw) return;
				if (result.outputFiles) {
					for (const file of result.outputFiles) {
						if (!shouldInjectOutput(file.path)) continue;
						const code = decoder.decode(file.contents);
						file.contents = encoder.encode(injectCodeRaw + code);
					}
					return;
				}
				if (!result.metafile) return;
				for (const outputPath of Object.keys(result.metafile.outputs)) {
					if (!shouldInjectOutput(outputPath)) continue;
					(0, fs.writeFileSync)(outputPath, injectCodeRaw + (0, fs.readFileSync)(outputPath, "utf8"));
				}
			});
		}
	};
}
//#endregion
module.exports = codeTransformerEsbuild;

//# sourceMappingURL=esbuild.cjs.map