import { Span, SpanAttributes } from '@sentry/core';
import { MongodbNamespace, MongoInternalCommand, MongoInternalTopology } from './internal-types';
import { MongodbCommandType } from './internal-types';
/**
 * Get the mongodb command type from the object.
 */
export declare function getCommandType(command: MongoInternalCommand): MongodbCommandType;
/**
 * Determine a span's attributes by fetching related metadata from the v4 connection context.
 */
export declare function getV4SpanAttributes(connectionCtx: any, ns: MongodbNamespace, command?: any, operation?: string): SpanAttributes;
/**
 * Determine a span's attributes by fetching related metadata from the v3 topology.
 */
export declare function getV3SpanAttributes(ns: string, topology: MongoInternalTopology, command?: MongoInternalCommand, operation?: string | undefined): SpanAttributes;
export declare function startMongoSpan(attributes: SpanAttributes): Span;
/**
 * Wraps the result handler so it ends the span (with error status on failure) and runs the
 * original callback re-activated under the parent span — mongodb loses the async context when
 * it invokes the callback on a later tick.
 */
export declare function patchEnd(span: Span | undefined, resultHandler: Function): Function;
export declare function shouldSkipInstrumentation(): boolean;
//# sourceMappingURL=utils.d.ts.map
