import { n as createCodeTransformer } from "./core-CudBBdLX.mjs";
import { readFileSync } from "node:fs";
//#region src/bun.ts
function loaderForPath(path) {
	if (path.endsWith(".tsx")) return "tsx";
	if (path.endsWith(".jsx")) return "jsx";
	if (path.endsWith(".ts") || path.endsWith(".cts") || path.endsWith(".mts")) return "ts";
	return "js";
}
function buildFilter(options) {
	const names = Array.from(new Set(options.instrumentations.map((i) => i.module.name))).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (names.length === 0) return /(?!)/;
	const alt = names.join("|");
	return new RegExp(`node_modules[/\\\\](?:${alt})[/\\\\].*\\.(?:cjs|mjs|cts|mts|tsx|jsx|ts|js)$`);
}
function codeTransformerBun(options) {
	const filter = buildFilter(options);
	return {
		name: "code-transformer",
		setup(build) {
			let transformer = createCodeTransformer(options);
			let diagnosticsInjected = false;
			if (typeof build.onStart === "function") build.onStart(() => {
				transformer = createCodeTransformer(options);
				diagnosticsInjected = false;
			});
			build.onLoad({
				filter,
				namespace: "file"
			}, (args) => {
				const contents = readFileSync(args.path, "utf8");
				const result = transformer.transform(contents, args.path);
				let transformedContents = result ? result.code : contents;
				if (options.injectDiagnostics && !diagnosticsInjected) {
					const injectCode = transformer.getCodeToInject();
					if (injectCode) {
						transformedContents = injectCode + transformedContents;
						diagnosticsInjected = true;
					}
				}
				const loader = loaderForPath(args.path);
				return {
					contents: transformedContents,
					loader
				};
			});
		}
	};
}
//#endregion
export { codeTransformerBun as default };

//# sourceMappingURL=bun.mjs.map