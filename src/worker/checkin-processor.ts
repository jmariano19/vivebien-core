import { Job } from 'bullmq';
import { logger } from '../infra/logging/logger';
import { handleCheckinJob, CheckinJobData } from './handlers/checkin';

/**
 * Process check-in jobs from the queue
 */
export async function processCheckinJob(job: Job<CheckinJobData>): Promise<{ sent: boolean }> {
  const jobLogger = logger.child({
    jobId: job.id,
    userId: job.data.userId,
    conversationId: job.data.conversationId,
  });

  jobLogger.info('Processing check-in job');

  try {
    const result = await handleCheckinJob(job.data, jobLogger);
    return result;
  } catch (err) {
    jobLogger.error({ err }, 'Check-in job processing failed');
    throw err;
  }
}
