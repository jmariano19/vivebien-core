/**
 * Plato Inteligente — Inbound Message Handler
 *
 * Flow: NO AI calls during the day (except Whisper for voice).
 *
 * NEW USER:
 *   1. Create client profile
 *   2. Send intro + Q1
 *   3. Set conversation phase = 'onboarding', onboarding_step = 1
 *
 * ONBOARDING (steps 1-5):
 *   1. Save answer to client profile
 *   2. If step < 5: send next question
 *   3. If step == 5: score archetype → save → send completion + archetype message
 *                    set phase = 'active'
 *
 * ACTIVE:
 *   1. Transcribe voice (Whisper) if needed
 *   2. Detect language
 *   3. Safety check (rule-based, no AI)
 *   4. Save raw input to health_events (processed=FALSE)
 *   5. Send smart ack (Haiku mirrors the user's words)
 *
 * All pattern detection and PDF generation happen in the nightly pipeline.
 */
import { Logger } from 'pino';
import { InboundJobData, JobResult } from '../../shared/types';
export declare function handleInboundMessage(data: InboundJobData, logger: Logger): Promise<JobResult>;
//# sourceMappingURL=inbound.d.ts.map