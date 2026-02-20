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

import { Worker, Job, Queue } from 'bullmq';
import { redis, closeRedis } from '../infra/queue/client';
import { processJob } from './processor';
import { processCheckinJob } from './checkin-processor';
import { config } from '../config';
import { logger } from '../infra/logging/logger';
import { db } from '../infra/db/client';
import { DigestService } from '../domain/digest/service';
import { HealthEventService } from '../domain/health-event/service';
import { ChatwootClient } from '../adapters/chatwoot/client';

const QUEUE_NAME = 'vivebien-inbound';
const CHECKIN_QUEUE_NAME = 'vivebien-checkin';
const DIGEST_QUEUE_NAME = 'plato-daily-digest';

const chatwootClient = new ChatwootClient();
const healthEventService = new HealthEventService(db);

// ============================================================================
// Heads-up messages (sent 15 min before summary)
// ============================================================================

const HEADS_UP_MESSAGES: Record<string, string> = {
  es: 'Estamos afinando tu resumen nocturno con cuidado. En aproximadamente 15 minutos lo tendrás listo. Si al leerlo hay algo que no refleja exactamente tu día o tus síntomas, escríbenos aquí mismo. Lo ajustamos para que el próximo sea aún más preciso y útil para ti.',
  en: "We're putting the finishing touches on your nightly summary. You'll have it in about 15 minutes. If anything doesn't reflect your day or symptoms accurately, just write us here. We'll adjust so the next one is even more precise and useful for you.",
  pt: 'Estamos finalizando seu resumo noturno com cuidado. Em aproximadamente 15 minutos estará pronto. Se ao ler houver algo que não reflete exatamente seu dia ou sintomas, escreva aqui mesmo. Ajustamos para que o próximo seja ainda mais preciso.',
  fr: "Nous préparons votre résumé nocturne avec soin. Dans environ 15 minutes il sera prêt. Si en le lisant quelque chose ne reflète pas exactement votre journée, écrivez-nous ici. Nous ajusterons pour que le prochain soit encore plus précis.",
};

// ============================================================================
// Worker 1: Inbound Messages
// ============================================================================

const worker = new Worker(QUEUE_NAME, processJob, {
  connection: redis,
  concurrency: config.workerConcurrency,
  maxStalledCount: 2,
  stalledInterval: 30000,
  lockDuration: config.jobTimeoutMs,
  settings: {
    backoffStrategy: (attemptsMade: number) => {
      return Math.min(Math.pow(2, attemptsMade) * 1000, 16000);
    },
  },
});

// ============================================================================
// Worker 2: Check-ins (24h follow-ups)
// ============================================================================

const checkinWorker = new Worker(CHECKIN_QUEUE_NAME, processCheckinJob, {
  connection: redis,
  concurrency: 2,
  maxStalledCount: 2,
  stalledInterval: 60000,
  lockDuration: 60000,
});

// ============================================================================
// Worker 3: Nightly Digest (generates summary + sends via WhatsApp)
// ============================================================================

const digestService = new DigestService(db);

const digestWorker = new Worker(
  DIGEST_QUEUE_NAME,
  async (job: Job) => {
    const { userId, language, userName, conversationId, jobType } = job.data;

    // ── Heads-up message job ──────────────────────────────────────────────
    if (jobType === 'heads-up') {
      logger.info({ userId, conversationId }, 'Sending heads-up message');
      const headsUpMsg = HEADS_UP_MESSAGES[language] || HEADS_UP_MESSAGES.es!;
      await chatwootClient.sendMessage(conversationId, headsUpMsg);
      return { sent: 'heads-up' };
    }

    // ── Generate digest job ───────────────────────────────────────────────
    logger.info({ userId, jobId: job.id }, 'Processing nightly digest');

    try {
      const result = await digestService.generateDigest(
        userId,
        new Date(),
        language || 'es',
        userName,
      );

      if (result.eventsProcessed === 0) {
        logger.info({ userId }, 'No events — skipping delivery');
        return result;
      }

      // Send summary as text message via WhatsApp
      if (conversationId && result.summaryData) {
        try {
          const summaryText = formatSummaryForWhatsApp(result.summaryData, language || 'es');
          await chatwootClient.sendMessage(conversationId, summaryText);
          logger.info({ userId, conversationId }, 'Nightly summary sent via WhatsApp');
        } catch (sendErr) {
          logger.error({ error: sendErr, userId }, 'Failed to send summary via WhatsApp');
        }
      }

      logger.info(
        { userId, eventCount: result.eventsProcessed },
        'Nightly digest completed',
      );

      return result;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to generate nightly digest');
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 3,
    maxStalledCount: 1,
    stalledInterval: 120000,
    lockDuration: 300000, // 5 min for AI + PDF generation
  },
);

// ============================================================================
// Digest Scheduler — Runs at DIGEST_CRON_HOUR daily
// ============================================================================

const digestQueue = new Queue(DIGEST_QUEUE_NAME, { connection: redis });

/**
 * Schedule nightly digest jobs for all users with health events today.
 *
 * Flow per user:
 * 1. Send heads-up message immediately
 * 2. Schedule digest generation with 15 min delay
 */
async function scheduleDigestJobs() {
  logger.info('Running nightly digest scheduler...');

  try {
    const today = new Date().toISOString().split('T')[0]!;

    // Find all users who have unprocessed health events today
    const usersResult = await db.query<{ user_id: string }>(
      `SELECT DISTINCT user_id
       FROM health_events
       WHERE event_date = $1
         AND processed = FALSE`,
      [today],
    );

    const userIds = usersResult.rows.map(r => r.user_id);

    if (userIds.length === 0) {
      logger.info('No users with events today — skipping digest generation');
      return;
    }

    for (const userId of userIds) {
      // Get user details
      const userResult = await db.query<{
        language: string;
        name: string | null;
      }>(
        'SELECT language, name FROM users WHERE id = $1',
        [userId],
      );

      if (userResult.rows.length === 0) continue;
      const user = userResult.rows[0]!;

      // Find the user's most recent conversation ID (for sending messages)
      const convResult = await db.query<{ conversation_id: number }>(
        `SELECT conversation_id FROM conversation_state
         WHERE user_id = $1
         ORDER BY updated_at DESC LIMIT 1`,
        [userId],
      );

      const conversationId = convResult.rows[0]?.conversation_id;
      if (!conversationId) {
        logger.warn({ userId }, 'No conversation found — skipping digest');
        continue;
      }

      const dateKey = today;

      // Step 1: Send heads-up message NOW
      await digestQueue.add('heads-up', {
        userId,
        language: user.language,
        userName: user.name,
        conversationId,
        jobType: 'heads-up',
      }, {
        jobId: `headsup-${userId}-${dateKey}`,
      });

      // Step 2: Schedule the actual digest generation with 15 min delay
      await digestQueue.add('generate-digest', {
        userId,
        language: user.language,
        userName: user.name,
        conversationId,
        jobType: 'generate-digest',
      }, {
        jobId: `digest-${userId}-${dateKey}`,
        delay: 15 * 60 * 1000, // 15 minutes
        attempts: 2,
        backoff: { type: 'exponential', delay: 30000 },
      });
    }

    logger.info(
      { userCount: userIds.length },
      'Nightly digest jobs scheduled (heads-up + digest)',
    );
  } catch (error) {
    logger.error({ error }, 'Failed to schedule digest jobs');
  }
}

// Schedule the cron — runs at DIGEST_CRON_HOUR every day
const digestCronHour = parseInt(process.env.DIGEST_CRON_HOUR || '21', 10);
digestQueue.add('schedule-digests', {}, {
  repeat: {
    pattern: `0 ${digestCronHour} * * *`,
  },
  jobId: 'daily-digest-scheduler',
}).then(() => {
  logger.info({ cronHour: digestCronHour }, 'Daily digest cron scheduled');
}).catch(err => {
  logger.error({ err }, 'Failed to schedule digest cron');
});

// Scheduler worker — handles the cron trigger
const digestSchedulerWorker = new Worker(
  DIGEST_QUEUE_NAME,
  async (job: Job) => {
    if (job.name === 'schedule-digests') {
      await scheduleDigestJobs();
      return { scheduled: true };
    }
    // Regular jobs handled by digestWorker
    return { skipped: true };
  },
  {
    connection: redis,
    concurrency: 1,
  },
);

// ============================================================================
// Format summary for WhatsApp text delivery
// ============================================================================

function formatSummaryForWhatsApp(
  data: Record<string, unknown>,
  language: string,
): string {
  const lines: string[] = [];

  // Header
  lines.push('_La comida y tu estilo de vida son medicina — con verdad y entendimiento._');
  lines.push('');

  // Greeting
  const name = (data.greeting_name as string) || '';
  lines.push(`*${name}, tu día tiene un patrón. Hoy lo hicimos visible.*`);
  lines.push(`Día ${data.day_number || 1} — ${data.date || ''}`);
  lines.push('');

  // Tu Plato Hoy
  const meals = (data.meals as Array<{ time: string; title: string; bullets: string[] }>) || [];
  if (meals.length > 0) {
    lines.push('*🍽 TU PLATO HOY*');
    for (const meal of meals) {
      lines.push(`*${meal.time}* — ${meal.title}`);
      for (const bullet of (meal.bullets || [])) {
        lines.push(`  • ${bullet}`);
      }
    }
    lines.push('');
  }

  // Señal Principal
  if (data.signal_intro) {
    lines.push('*📊 SEÑAL PRINCIPAL DE HOY*');
    lines.push(data.signal_intro as string);
    const items = (data.signal_items as Array<{ direction: string; text: string }>) || [];
    for (const item of items) {
      const arrow = item.direction === 'up' ? '↑' : '↓';
      lines.push(`  ${arrow} ${item.text}`);
    }
    if (data.signal_explanation) {
      lines.push(`\n_${data.signal_explanation}_`);
    }
    lines.push('');
  }

  // Esto No Es Fuerza de Voluntad
  if (data.willpower_text) {
    lines.push('*💪 ESTO NO ES FUERZA DE VOLUNTAD*');
    lines.push(data.willpower_text as string);
    lines.push('');
  }

  // Tu Ventaja Metabólica
  if (data.advantage_text) {
    lines.push('*⚡ TU VENTAJA METABÓLICA*');
    lines.push(data.advantage_text as string);
    lines.push('');
  }

  // Patrón Emergente
  if (data.pattern_text) {
    lines.push('*🔍 PATRÓN EMERGENTE*');
    lines.push(data.pattern_text as string);
    lines.push('');
  }

  // Tus Preguntas
  const questions = (data.questions as Array<{ question: string; answer: string }>) || [];
  if (questions.length > 0) {
    lines.push('*❓ TUS PREGUNTAS*');
    for (const q of questions) {
      lines.push(`_Tu preguntaste: "${q.question}"_`);
      lines.push(q.answer);
      lines.push('');
    }
  }

  // Experimento
  if (data.experiment_heading) {
    lines.push('*🧪 EXPERIMENTO PARA MAÑANA*');
    lines.push(data.experiment_heading as string);
    const steps = (data.experiment_steps as string[]) || [];
    steps.forEach((step, i) => {
      lines.push(`${i + 1}. ${step}`);
    });
    if (data.observe_text) {
      lines.push(`\n🔎 Observa: ${data.observe_text}`);
    }
    lines.push('');
  }

  // Closing
  lines.push('_No estás haciendo dieta. Estás aprendiendo a leer tu biología._');
  lines.push('');
  lines.push('Revisión: Dra. Hernández | Tu Plato Inteligente');

  return lines.join('\n');
}

// ============================================================================
// Event Handlers
// ============================================================================

checkinWorker.on('ready', () => {
  logger.info({ queue: CHECKIN_QUEUE_NAME }, 'Check-in worker ready');
});

checkinWorker.on('completed', (job: Job) => {
  logger.info({ jobId: job.id, userId: job.data.userId }, 'Check-in job completed');
});

checkinWorker.on('failed', (job: Job | undefined, err: Error) => {
  logger.error({ jobId: job?.id, userId: job?.data?.userId, error: err.message }, 'Check-in job failed');
});

digestWorker.on('ready', () => {
  logger.info({ queue: DIGEST_QUEUE_NAME }, 'Digest worker ready');
});

digestWorker.on('completed', (job: Job) => {
  logger.info({ jobId: job.id, userId: job.data.userId }, 'Digest job completed');
});

digestWorker.on('failed', (job: Job | undefined, err: Error) => {
  logger.error({ jobId: job?.id, error: err.message }, 'Digest job failed');
});

worker.on('ready', () => {
  logger.info({ queue: QUEUE_NAME, concurrency: config.workerConcurrency }, 'Worker ready');
});

worker.on('completed', (job: Job) => {
  logger.info({
    jobId: job.id,
    correlationId: job.data.correlationId,
    duration: Date.now() - job.timestamp,
  }, 'Job completed');
});

worker.on('failed', (job: Job | undefined, err: Error) => {
  logger.error({
    jobId: job?.id,
    correlationId: job?.data?.correlationId,
    error: err.message,
    stack: err.stack,
    attemptsMade: job?.attemptsMade,
  }, 'Job failed');
});

worker.on('error', (err: Error) => {
  logger.error({ error: err.message }, 'Worker error');
});

worker.on('stalled', (jobId: string) => {
  logger.warn({ jobId }, 'Job stalled');
});

// ============================================================================
// Graceful Shutdown
// ============================================================================

let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Worker received shutdown signal');

  try {
    await worker.pause();
    logger.info('Worker paused, waiting for active jobs...');

    const timeout = setTimeout(() => {
      logger.warn('Shutdown timeout, forcing close');
      process.exit(1);
    }, 30000);

    await worker.close();
    await checkinWorker.close();
    await digestWorker.close();
    await digestSchedulerWorker.close();
    await digestQueue.close();
    clearTimeout(timeout);

    await db.end();
    await closeRedis();

    logger.info('Worker shut down gracefully');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during worker shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

logger.info({ queue: QUEUE_NAME }, 'Worker starting...');
