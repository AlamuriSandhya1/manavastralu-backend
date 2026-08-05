import { Span, SpanAttributes } from '@sentry/core';
import { Collection } from './mongoose-types';
export declare function getAttributesFromCollection(collection: Collection): SpanAttributes;
export declare function handlePromiseResponse(execResponse: any, span: Span): any;
export declare function handleCallbackResponse(callback: Function, exec: Function, originalThis: any, span: Span, args: IArguments): any;
//# sourceMappingURL=utils.d.ts.map
