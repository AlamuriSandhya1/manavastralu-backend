import { InstrumentationConfig } from '@apm-js-collab/code-transformer';
type Diagnostics = {
    transformedModules: string[];
    failedModules: string[];
};
export declare const COMMENT_USE_STRICT_REGEX: RegExp;
/**
 * Checks if a file is a JavaScript file based on its extension.
 * Handles query strings and hashes in the filename.
 */
export declare function isJsFile(fileName: string): boolean;
/**
 * Checks if a chunk contains only import/export statements and no substantial code.
 *
 * In Vite MPA (multi-page application) mode, HTML entry points create "facade" chunks
 * that only contain import statements to load shared modules. These should not have
 * Sentry code injected. However, in SPA mode, the main bundle also has an HTML facade
 * but contains substantial application code that SHOULD have debug IDs injected.
 *
 * @ref https://github.com/getsentry/sentry-javascript-bundler-plugins/issues/829
 * @ref https://github.com/getsentry/sentry-javascript-bundler-plugins/issues/839
 */
export declare function containsOnlyImports(code: string): boolean;
/**
 * Checks if a chunk should be skipped for code injection
 *
 * This is necessary to handle Vite's MPA (multi-page application) mode where
 * HTML entry points create "facade" chunks that should not contain injected code.
 * See: https://github.com/getsentry/sentry-javascript-bundler-plugins/issues/829
 *
 * However, in SPA mode, the main bundle also has an HTML facade but contains
 * substantial application code. We should NOT skip injection for these bundles.
 *
 * @param code - The chunk's code content
 * @param facadeModuleId - The facade module ID (if any) - HTML files create facade chunks
 * @returns true if the chunk should be skipped
 */
export declare function shouldSkipCodeInjection(code: string, facadeModuleId: string | null | undefined): boolean;
export interface CodeTransformerPluginOptions {
    /** Array of instrumentation configurations */
    instrumentations: InstrumentationConfig[];
    /** Optional path to a polyfill module for diagnostics_channel */
    dcModule?: string;
    /** Optional callback that that injects the code returned */
    injectDiagnostics?: (diagnostics: Diagnostics) => string | undefined;
}
export interface TransformResult {
    code: string;
    map?: string;
}
/**
 * Build a reusable code transformer from plugin options. The returned
 * `transform` function returns `null` for files that should not be modified.
 * Call `dispose` when the bundler tears the plugin down.
 */
export declare function createCodeTransformer(options: CodeTransformerPluginOptions): {
    transform: (code: string, id: string, inputSourceMap?: string | object | null) => TransformResult | null;
    getCodeToInject: () => string | undefined;
};
export {};
//# sourceMappingURL=core.d.mts.map