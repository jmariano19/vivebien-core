/**
 * Plato Inteligente — Worker Entry Point
 *
 * Workers:
 * 1. Inbound message worker (save + ack, zero AI during day)
 * 2. Check-in worker (24h follow-ups)
 * 3. Nightly digest worker (ONE Haiku call → PDF → WhatsApp delivery)
 * 4. Digest scheduler (cron at DIGEST_CRON_HOUR, schedules per-user jobs)
 *
 * Nightly sequence per user:
 *   T-15min: Send heads-up message
 *   T-0:     Generate digest (Haiku) → Send summary text via WhatsApp
 */
export {};
//# sourceMappingURL=index.d.ts.map