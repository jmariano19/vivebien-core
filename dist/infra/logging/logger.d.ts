import pino, { Logger } from 'pino';
export declare const logger: pino.Logger<never, boolean>;
interface ExecutionLogInput {
    correlationId: string;
    jobId?: string;
    userId?: string;
    action: string;
    status: 'started' | 'completed' | 'failed';
    durationMs?: number;
    input?: unknown;
    output?: unknown;
    error?: unknown;
}
export declare function saveExecutionLog(log: ExecutionLogInput): Promise<void>;
export declare function logExecution<T>(correlationId: string, action: string, fn: () => Promise<T>, parentLogger?: Logger, options?: {
    logInput?: unknown;
    skipDbLog?: boolean;
}): Promise<T>;
interface AIUsageLog {
    userId: string;
    correlationId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
}
export declare function logAIUsage(usage: AIUsageLog): Promise<void>;
export declare function createChildLogger(bindings: Record<string, unknown>): Logger;
export {};
//# sourceMappingURL=logger.d.ts.map