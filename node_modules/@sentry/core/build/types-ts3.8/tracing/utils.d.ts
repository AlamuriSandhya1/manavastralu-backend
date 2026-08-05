import { Scope } from '../scope';
import { Span } from '../types/span';
/** Store the scope & isolation scope for a span, which can the be used when it is finished. */
export declare function setCapturedScopesOnSpan(span: Span | undefined, scope: Scope, isolationScope: Scope): void;
/**
 * Grabs the scope and isolation scope off a span that were active when the span was started.
 * If WeakRef was used and scopes have been garbage collected, returns undefined for those scopes.
 */
export declare function getCapturedScopesOnSpan(span: Span): {
    scope?: Scope;
    isolationScope?: Scope;
};
/**
 * Mark a span as eligible for OTel-style `sentry.source` inference at span end.
 * Set by `SentryTraceProvider` on the spans it creates; read by `SentrySpan.updateName()` and
 * `applyOtelSpanData()`.
 */
export declare function markSpanForOtelSourceInference(span: Span): void;
/** Whether a span is marked for OTel-style `sentry.source` inference (see {@link markSpanForOtelSourceInference}). */
export declare function spanShouldInferOtelSource(span: Span): boolean;
//# sourceMappingURL=utils.d.ts.map
