import { t as codeTransformerRollup } from "./rollup-2TLy32jO.mjs";
//#region src/vite.ts
function codeTransformerVite(options) {
	return {
		enforce: "pre",
		...codeTransformerRollup(options)
	};
}
//#endregion
export { codeTransformerVite as default };

//# sourceMappingURL=vite.mjs.map