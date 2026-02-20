/**
 * Plato Inteligente — Nightly Digest Service
 *
 * Generates the nightly summary using ONE Sonnet call:
 * 1. Collect all unprocessed health_events for the day
 * 2. Load user profile + last 7 days of events for patterns
 * 3. Send ONE Sonnet call with the Nightly Summary Framework prompt
 * 4. Receive structured JSON matching the PDF data dict
 * 5. Mark events as processed
 * 6. Save digest to daily_digests table
 *
 * Cost: ~$0.005-0.01 per user per night (Sonnet 4.5)
 */
import { Pool } from 'pg';
export interface DailyDigest {
    id: string;
    userId: string;
    digestDate: string;
    eventCount: number;
    pdfUrl: string | null;
    summaryJson: Record<string, unknown> | null;
    createdAt: Date;
}
export interface DigestGenerationResult {
    digest: DailyDigest;
    summaryData: Record<string, unknown>;
    eventsProcessed: number;
}
export interface UserProfile {
    name: string;
    language: string;
    timezone: string;
    dayCount: number;
    pronouns?: string;
    languageStyle?: Record<string, string>;
    communicationStyle?: string;
    motivation?: string;
    keyPattern?: string;
    metabolicAdvantage?: string;
    whatNotToDo?: string[];
}
export declare class DigestService {
    private db;
    private client;
    private rateLimiter;
    private healthEventService;
    constructor(db: Pool);
    /**
     * Generate the full nightly digest for a user.
     * ONE Sonnet call processes the entire day.
     */
    generateDigest(userId: string, date: Date, language: string, userName?: string): Promise<DigestGenerationResult>;
    /**
     * The ONE AI call — Sonnet processes the entire day.
     */
    private generateSummaryWithSonnet;
    /**
     * Load user profile from the database.
     */
    private loadUserProfile;
    /**
     * Get recent summaries for continuity context.
     */
    private getRecentSummaries;
    /**
     * Summarize a week of events into a concise string for the prompt.
     */
    private summarizeWeekEvents;
    /**
     * Infer event type from raw input (simple heuristic).
     * The real classification happens in the Sonnet call, but we need
     * something for the markProcessed call.
     */
    private inferEventType;
    /**
     * Save or update a daily digest.
     */
    private saveDigest;
    /**
     * Update the PDF URL after generation.
     */
    updatePdfUrl(digestId: string, pdfUrl: string): Promise<void>;
    /**
     * Get a specific daily digest.
     */
    getDigest(userId: string, date: string): Promise<DailyDigest | null>;
    private mapRow;
}
//# sourceMappingURL=service.d.ts.map