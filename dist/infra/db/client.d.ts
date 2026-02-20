import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
export declare const db: Pool;
export declare function checkDatabaseHealth(): Promise<{
    healthy: boolean;
    latencyMs: number;
    connections: {
        total: number;
        idle: number;
        waiting: number;
    };
}>;
export declare function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
export declare function queryOne<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T | null>;
export declare function queryMany<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>;
export declare function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>;
export declare function checkIdempotencyKey(key: string): Promise<unknown | null>;
export declare function setIdempotencyKey(key: string, result: unknown, ttlHours?: number): Promise<void>;
export declare function getFeatureFlag(key: string): Promise<{
    enabled: boolean;
    value: unknown;
} | null>;
export declare function getActivePrompt(name: string): Promise<string | null>;
export declare function getConfigTemplate(key: string, language?: 'es' | 'en'): Promise<string | null>;
export declare function getCreditCost(action: string): Promise<number>;
//# sourceMappingURL=client.d.ts.map