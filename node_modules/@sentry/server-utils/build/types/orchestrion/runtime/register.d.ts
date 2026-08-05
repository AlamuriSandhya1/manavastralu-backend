declare global {
    var __SENTRY_ORCHESTRION__: {
        runtime?: boolean;
        bundler?: boolean;
    } | undefined;
}
/**
 * Synchronously register the diagnostics-channel injection module hooks.
 *
 * This is the single source of truth for the registration logic. It is used by:
 * - `Sentry.init()` (the Node SDK calls it directly — that's why this module
 *   must be CJS-compatible / dual-built, so it can be `require()`d synchronously
 *   before the app's `import`s resolve), and
 * - `import-hook.mjs`, the side-effecting `--import` entry, which just calls it.
 *
 * Libraries imported *after* this call publish the `tracingChannel` events that
 * the channel-based integrations subscribe to.
 *
 * Idempotent via `globalThis.__SENTRY_ORCHESTRION__` — a no-op if the runtime
 * `--import` hook or a bundler plugin already injected the channels.
 */
export declare function registerDiagnosticsChannelInjection(): void;
//# sourceMappingURL=register.d.ts.map