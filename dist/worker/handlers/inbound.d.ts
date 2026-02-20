/**
 * Plato Inteligente — Inbound Message Handler
 *
 * Simplified flow: NO AI calls during the day.
 *   1. Load/create user
 *   2. Transcribe voice (Whisper) if needed
 *   3. Detect & update language
 *   4. Safety check (rule-based crisis keywords)
 *   5. Detect if it's a question
 *   6. Save raw input to health_events (processed=FALSE)
 *   7. Send template ack via Chatwoot
 *
 * All intelligence is concentrated in the nightly pipeline.
 */
import { Logger } from 'pino';
import { InboundJobData, JobResult } from '../../shared/types';
export declare function handleInboundMessage(data: InboundJobData, logger: Logger): Promise<JobResult>;
//# sourceMappingURL=inbound.d.ts.map