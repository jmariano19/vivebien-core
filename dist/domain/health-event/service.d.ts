/**
 * Plato Inteligente — HealthEventService
 *
 * Phase 1 (inbound): saves raw user input to health_events with processed=FALSE.
 * Phase 2 (nightly): the nightly pipeline fills event_type + extracted_data.
 *
 * Zero AI calls during the day. All intelligence concentrated at night.
 */
import { Pool } from 'pg';
export interface HealthEvent {
    id: string;
    userId: string;
    eventType: string | null;
    eventTime: Date;
    eventDate: string;
    rawInput: string | null;
    imageUrl: string | null;
    extractedData: Record<string, unknown>;
    isQuestion: boolean;
    processed: boolean;
    source: string;
    language: string | null;
    createdAt: Date;
}
export interface SaveEventInput {
    userId: string;
    rawInput: string | null;
    imageUrl?: string | null;
    language?: string | null;
    isQuestion?: boolean;
    source?: string;
}
export declare class HealthEventService {
    private pool;
    constructor(pool: Pool);
    /**
     * Save a raw health event — no AI, no classification.
     * event_type stays NULL until the nightly pipeline processes it.
     */
    saveEvent(input: SaveEventInput): Promise<HealthEvent>;
    /**
     * Get all unprocessed events for a user on a given date.
     * Used by the nightly pipeline to batch-process the day's inputs.
     */
    getUnprocessedEvents(userId: string, date?: string): Promise<HealthEvent[]>;
    /**
     * Get events for a date range (used for weekly summaries / pattern detection).
     */
    getEventsByDateRange(userId: string, startDate: string, endDate: string): Promise<HealthEvent[]>;
    /**
     * Mark events as processed after the nightly pipeline runs.
     * Also fills in event_type and extracted_data from the AI analysis.
     */
    markProcessed(eventId: string, eventType: string, extractedData: Record<string, unknown>): Promise<void>;
    /**
     * Count today's events for a user (useful for ack message variation).
     */
    countTodayEvents(userId: string): Promise<number>;
}
//# sourceMappingURL=service.d.ts.map