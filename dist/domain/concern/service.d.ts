import { Pool } from 'pg';
export type ConcernStatus = 'active' | 'improving' | 'resolved';
export type ChangeType = 'auto_update' | 'user_edit' | 'status_change';
export interface HealthConcern {
    id: string;
    userId: string;
    title: string;
    status: ConcernStatus;
    summaryContent: string | null;
    icon: string | null;
    createdAt: Date;
    updatedAt: Date;
}
export interface ConcernSnapshot {
    id: string;
    concernId: string;
    userId: string;
    content: string;
    changeType: ChangeType;
    status: string | null;
    createdAt: Date;
}
export declare class ConcernService {
    private db;
    constructor(db: Pool);
    /**
     * Get all active (non-resolved) concerns for a user
     */
    getActiveConcerns(userId: string): Promise<HealthConcern[]>;
    /**
     * Get ALL concerns for a user (including resolved) — for history page
     */
    getAllConcerns(userId: string): Promise<HealthConcern[]>;
    /**
     * Get a single concern by ID.
     * Optional userId parameter enforces ownership validation when provided.
     */
    getConcernById(concernId: string, userId?: string): Promise<HealthConcern | null>;
    /**
     * Fuzzy-match an existing concern or create a new one.
     * Uses shared matching utility for exact, substring, and word overlap matching,
     * then applies health synonym and condition-symptom logic as additional layers.
     */
    getOrCreateConcern(userId: string, title: string, icon?: string): Promise<HealthConcern>;
    /**
     * Check if one title is a symptom commonly associated with a broader condition.
     * E.g., "cough" is a symptom of "flu", "nausea" is a symptom of "food poisoning"
     */
    private isSymptomOfCondition;
    private areHealthSynonyms;
    /**
     * Rename an existing concern (e.g., when user switches languages)
     */
    renameConcern(concernId: string, newTitle: string): Promise<void>;
    /**
     * Create a brand new concern
     */
    createConcern(userId: string, title: string, icon?: string): Promise<HealthConcern>;
    /**
     * Update a concern's summary. Creates a snapshot if the change is meaningful.
     */
    updateConcernSummary(concernId: string, newContent: string, changeType: ChangeType): Promise<void>;
    /**
     * Change the status of a concern (active → improving → resolved)
     */
    updateConcernStatus(concernId: string, newStatus: ConcernStatus): Promise<void>;
    /**
     * Delete a concern and all its snapshots (cascading)
     */
    deleteConcern(concernId: string): Promise<void>;
    /**
     * Get the full snapshot history for a concern
     */
    getConcernHistory(concernId: string): Promise<ConcernSnapshot[]>;
    /**
     * Get the primary (most recently updated) active concern for backward compat
     */
    getPrimaryConcern(userId: string): Promise<HealthConcern | null>;
    /**
     * Get recent user edits (from the landing page) since a given timestamp.
     * Returns concern title + what changed for each user_edit snapshot.
     */
    getRecentUserEdits(userId: string, since: Date): Promise<Array<{
        title: string;
        content: string;
        editedAt: Date;
    }>>;
    /**
     * Detect if new content is meaningfully different from old content.
     * Compares key structured fields rather than raw text.
     */
    hasMeaningfulChange(oldContent: string | null, newContent: string): boolean;
    /**
     * Extract key fields from a summary for comparison
     */
    private extractKeyFields;
    /**
     * Map a database row to a HealthConcern object
     */
    private mapRow;
}
//# sourceMappingURL=service.d.ts.map