import { InstrumentationConfig } from '@apm-js-collab/code-transformer';
/**
 * Webpack loader that instruments JavaScript code using code-transformer
 *
 * This is a webpack loader (not a plugin) for compatibility with tools that only support loaders,
 * such as Next.js Turbopack. Unlike the other exports in this package, this does not use unplugin.
 */
declare function codeTransformerLoader(this: any, code: string, inputSourceMap?: any): any;
declare namespace codeTransformerLoader {
    /** Options for the code transformer webpack loader */
    interface Options {
        /** Array of instrumentation configurations */
        instrumentations: InstrumentationConfig[];
        /** Optional path to a polyfill module for diagnostics_channel */
        dcModule?: string;
    }
}
export default codeTransformerLoader;
//# sourceMappingURL=webpack-loader.d.mts.map