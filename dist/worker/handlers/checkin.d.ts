import { Logger } from 'pino';
/**
 * Job data for check-in queue
 */
export interface CheckinJobData {
    userId: string;
    conversationId: number;
    scheduledAt: string;
}
/**
 * Handle the 24-hour check-in job when it fires
 */
export declare function handleCheckinJob(data: CheckinJobData, logger: Logger): Promise<{
    sent: boolean;
}>;
/**
 * Process a check-in response from the user
 * Called from the main inbound handler when checkin_status = 'sent'
 */
export declare function processCheckinResponse(userId: string, userMessage: string, conversationId: number, logger: Logger): Promise<{
    isCheckinResponse: boolean;
    acknowledgment?: string;
    noteEntry?: string;
}>;
//# sourceMappingURL=checkin.d.ts.map