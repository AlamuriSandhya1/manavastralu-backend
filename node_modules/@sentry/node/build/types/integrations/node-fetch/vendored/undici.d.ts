import type { UndiciInstrumentationConfig } from './types';
export declare class UndiciInstrumentation {
    private _channelSubs;
    private _spanFromReq;
    private _propagationDecisionMap;
    private _config;
    constructor(config?: UndiciInstrumentationConfig);
    disable(): void;
    /** Subscribe to the undici diagnostics channels (idempotent). */
    enable(): void;
    private subscribeToChannel;
    private parseRequestHeaders;
    private onRequestCreated;
    private onRequestHeaders;
    private onResponseHeaders;
    private onDone;
    private onError;
    private injectTracePropagationHeaders;
    private getRequestMethod;
}
//# sourceMappingURL=undici.d.ts.map