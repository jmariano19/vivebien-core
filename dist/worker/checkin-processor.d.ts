import { Job } from 'bullmq';
import { CheckinJobData } from './handlers/checkin';
/**
 * Process check-in jobs from the queue
 */
export declare function processCheckinJob(job: Job<CheckinJobData>): Promise<{
    sent: boolean;
}>;
//# sourceMappingURL=checkin-processor.d.ts.map