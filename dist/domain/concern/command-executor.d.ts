/**
 * Executes concern management commands against the database.
 * Handles merge, delete, and rename operations with fuzzy matching
 * and automatic legacy memory aggregation.
 */
import { Pool } from 'pg';
import { Logger } from 'pino';
export declare class ConcernCommandExecutor {
    private db;
    private logger;
    private concernService;
    constructor(db: Pool, logger: Logger);
    /**
     * Execute a merge command: combine two or more concerns into one.
     * Returns the actual matched concern names that were merged.
     */
    executeMerge(userId: string, targetNames: string[]): Promise<string[]>;
    /**
     * Execute a delete command: remove a concern from the user's records.
     * Returns the actual matched concern name that was deleted.
     */
    executeDelete(userId: string, targetName: string): Promise<string[]>;
    /**
     * Execute a rename command: change a concern's title.
     * Returns [oldTitle, newTitle] for confirmation messaging.
     */
    executeRename(userId: string, targetName: string, newName: string): Promise<string[]>;
    /**
     * Update the legacy memories table with aggregated active concerns.
     * Fetches all active concerns and combines them into a single "health_summary" entry
     * with the format: "--- Title ---\n[content]\n\n--- Title ---\n[content]"
     */
    private updateLegacyMemories;
    /**
     * Upsert a health_summary entry into the memories table.
     */
    private upsertMemorySummary;
}
//# sourceMappingURL=command-executor.d.ts.map