import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import type { FMember, FPMember, FsInstrumentationConfig, GenericFunction } from './types';
export declare class FsInstrumentation extends InstrumentationBase<FsInstrumentationConfig> {
    constructor(config?: FsInstrumentationConfig);
    init(): InstrumentationNodeModuleDefinition[];
    protected _patchSyncFunction<T extends GenericFunction>(functionName: FMember, original: T): T;
    protected _patchCallbackFunction<T extends GenericFunction>(functionName: FMember, original: T): T;
    protected _patchExistsCallbackFunction<T extends GenericFunction>(functionName: 'exists', original: T): T;
    protected _patchPromiseFunction<T extends GenericFunction>(functionName: FPMember, original: T): T;
}
//# sourceMappingURL=instrumentation.d.ts.map