const require_rollup = require("./rollup-D64Yto89.cjs");
//#region src/vite.ts
function codeTransformerVite(options) {
	return {
		enforce: "pre",
		...require_rollup.codeTransformerRollup(options)
	};
}
//#endregion
module.exports = codeTransformerVite;

//# sourceMappingURL=vite.cjs.map