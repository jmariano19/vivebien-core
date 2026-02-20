import { Job } from 'bullmq';
import { InboundJobData, JobResult } from '../shared/types';
export type JobType = 'inbound_message' | 'process_media' | 'send_response';
export declare function processJob(job: Job<InboundJobData>): Promise<JobResult>;
//# sourceMappingURL=processor.d.ts.map