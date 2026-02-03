import { Logger } from 'pino';
import { CheckinService } from '../../domain/checkin/service';
import { ConversationService } from '../../domain/conversation/service';
import { db } from '../../infra/db/client';
import { getCheckinQueue } from '../../infra/queue/client';

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
export async function handleCheckinJob(
  data: CheckinJobData,
  logger: Logger
): Promise<{ sent: boolean }> {
  const { userId, conversationId } = data;

  logger.info({ userId, conversationId }, 'Processing 24h check-in job');

  const checkinQueue = getCheckinQueue();
  const checkinService = new CheckinService(db, checkinQueue);

  try {
    const sent = await checkinService.executeCheckin(userId, conversationId);
    logger.info({ userId, sent }, 'Check-in job completed');
    return { sent };
  } catch (err) {
    logger.error({ userId, err }, 'Check-in job failed');
    throw err;
  }
}

/**
 * Process a check-in response from the user
 * Called from the main inbound handler when checkin_status = 'sent'
 */
export async function processCheckinResponse(
  userId: string,
  userMessage: string,
  conversationId: number,
  logger: Logger
): Promise<{
  isCheckinResponse: boolean;
  acknowledgment?: string;
  noteEntry?: string;
}> {
  const checkinQueue = getCheckinQueue();
  const checkinService = new CheckinService(db, checkinQueue);
  const conversationService = new ConversationService(db);

  const response = await checkinService.handleCheckinResponse(userId, userMessage);

  if (!response) {
    return { isCheckinResponse: false };
  }

  // Update the health summary with the follow-up entry
  try {
    const currentSummary = await conversationService.getHealthSummary(userId);
    if (currentSummary) {
      const updatedSummary = currentSummary + '\n\n---\n' + response.noteEntry;

      // Update the summary in the database
      await db.query(
        `UPDATE memories
         SET content = $1, created_at = NOW()
         WHERE user_id = $2 AND category = 'health_summary'`,
        [updatedSummary, userId]
      );

      logger.info({ userId }, 'Health summary updated with check-in follow-up');
    }
  } catch (err) {
    logger.error({ userId, err }, 'Failed to update health summary with check-in');
  }

  return {
    isCheckinResponse: true,
    acknowledgment: response.acknowledgment,
    noteEntry: response.noteEntry,
  };
}
