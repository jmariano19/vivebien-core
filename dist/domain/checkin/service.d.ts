import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { CheckinStatus, CheckinState } from '../../shared/types';
export declare class CheckinService {
    private db;
    private checkinQueue;
    private chatwootClient;
    constructor(db: Pool, checkinQueue: Queue);
    private getCheckinMessage;
    private getCheckinAcknowledgment;
    getCheckinState(userId: string): Promise<CheckinState | null>;
    updateCheckinStatus(userId: string, status: CheckinStatus, scheduledFor?: Date): Promise<void>;
    updateLastSummaryCreatedAt(userId: string, caseLabel?: string): Promise<void>;
    updateLastUserMessageAt(userId: string): Promise<void>;
    updateLastBotMessageAt(userId: string): Promise<void>;
    /**
     * Schedule a 24-hour check-in after a summary is created
     * Called immediately after sending the post-summary handoff message
     */
    scheduleCheckin(userId: string, conversationId: number, caseLabel?: string): Promise<void>;
    /**
     * Cancel an existing scheduled check-in
     */
    cancelExistingCheckin(userId: string): Promise<void>;
    /**
     * Execute the check-in when the job fires
     * Returns true if message was sent, false if skipped
     */
    executeCheckin(userId: string, conversationId: number): Promise<boolean>;
    /**
     * Handle user's response to a check-in
     * Returns the acknowledgment message to send, or null if not a check-in response
     */
    handleCheckinResponse(userId: string, userMessage: string): Promise<{
        acknowledgment: string;
        noteEntry: string;
    } | null>;
    /**
     * Extract a simple case label from the summary for use in check-in message
     * e.g., "your eye", "your back", "your headache"
     */
    extractCaseLabel(summary: string, language: string): string | null;
}
//# sourceMappingURL=service.d.ts.map