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
const REMINDER_QUEUE_NAME = 'plato-daily-reminder';

const chatwootClient = new ChatwootClient();
const healthEventService = new HealthEventService(db);

// ============================================================================
// Heads-up messages (sent 15 min before summary)
// ============================================================================

const HEADS_UP_MESSAGES: Record<string, string> = {
  es: 'Estamos terminando tu resumen nocturno. En unos 15 minutos lo tendrás listo.\nSi algo no refleja exactamente tu día o cómo te sentiste, escríbenos aquí mismo. Lo afinamos para que cada noche sea más clara que la anterior.',
  en: "Your nightly summary is almost ready. You'll have it in about 15 minutes.\nIf anything doesn't quite match your day, just write us here. We'll fine-tune it so each night gets clearer.",
  pt: 'Seu resumo noturno está quase pronto. Em uns 15 minutos estará listo.\nSe algo não refletir exatamente seu dia, escreva aqui. Ajustamos para que cada noite seja mais clara.',
  fr: "Votre résumé nocturne est presque prêt. Dans environ 15 minutes il sera là.\nSi quelque chose ne reflète pas votre journée, écrivez-nous ici. On ajuste pour que chaque soir soit plus clair.",
};

// ============================================================================
// Daily Food Log Reminder Messages
// ============================================================================

const FOOD_LOG_REMINDERS: Record<string, string[]> = {
  es: [
    '¿Cómo estuvo tu día? Cuéntame lo que comiste — texto, foto o nota de voz. 🍽',
    'Antes de que se te olvide, ¿qué comiste hoy? Mándame lo que recuerdes. 📋',
    '¿Cómo fue el día de hoy? Mándame tu registro cuando puedas. 🌙',
    'Ya casi termina el día. ¿Qué comiste hoy? 🍽',
  ],
  en: [
    "How was your day? Tell me what you ate — text, photo, or voice note. 🍽",
    "Before you forget — what did you eat today? Send me whatever you remember. 📋",
    "How did today go? Send me your log when you can. 🌙",
    "Day's almost done. What did you eat today? 🍽",
  ],
  pt: [
    'Como foi seu dia? Me conta o que você comeu — texto, foto ou nota de voz. 🍽',
    'Antes de esquecer, o que você comeu hoje? Me manda o que lembrar. 📋',
    'Como foi o dia de hoje? Me manda seu registro quando puder. 🌙',
  ],
  fr: [
    "Comment s'est passée votre journée ? Dites-moi ce que vous avez mangé — texte, photo ou note vocale. 🍽",
    "Avant d'oublier — qu'avez-vous mangé aujourd'hui ? Envoyez-moi ce dont vous vous souvenez. 📋",
    "La journée touche à sa fin. Qu'avez-vous mangé aujourd'hui ? 🌙",
  ],
};

function getReminder(language: string): string {
  const lang = language in FOOD_LOG_REMINDERS ? language : 'es';
  const pool = FOOD_LOG_REMINDERS[lang]!;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

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

      // Summary saved as pending — Jeff approves in dashboard before it's sent
      logger.info(
        { userId, eventCount: result.eventsProcessed, nightlySummaryId: result.nightlySummaryId },
        'Nightly digest generated — pending approval in dashboard',
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

      // Schedule digest generation (no heads-up — Jeff approves before delivery)
      await digestQueue.add('generate-digest', {
        userId,
        language: user.language,
        userName: user.name,
        conversationId,
        jobType: 'generate-digest',
      }, {
        jobId: `digest-${userId}-${dateKey}`,
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
// Daily Reminder — Scheduler + Worker
// ============================================================================

const reminderQueue = new Queue(REMINDER_QUEUE_NAME, { connection: redis });

async function scheduleReminderJobs() {
  logger.info('Running daily reminder scheduler...');

  try {
    // Find all active users (phase = active in conversation_state)
    const usersResult = await db.query<{
      user_id: string;
      language: string;
      conversation_id: number;
    }>(
      `SELECT cs.user_id, u.language, cs.conversation_id
       FROM conversation_state cs
       JOIN users u ON u.id = cs.user_id
       WHERE cs.phase = 'active'
         AND cs.conversation_id IS NOT NULL`,
    );

    if (usersResult.rows.length === 0) {
      logger.info('No active users for daily reminder');
      return;
    }

    const today = new Date().toISOString().split('T')[0]!;

    for (const user of usersResult.rows) {
      await reminderQueue.add('send-reminder', {
        userId: user.user_id,
        language: user.language,
        conversationId: user.conversation_id,
      }, {
        jobId: `reminder-${user.user_id}-${today}`,
        attempts: 2,
        backoff: { type: 'exponential', delay: 15000 },
      });
    }

    logger.info({ userCount: usersResult.rows.length }, 'Daily reminder jobs scheduled');
  } catch (error) {
    logger.error({ error }, 'Failed to schedule reminder jobs');
  }
}

const reminderWorker = new Worker(
  REMINDER_QUEUE_NAME,
  async (job: Job) => {
    if (job.name === 'schedule-reminders') {
      await scheduleReminderJobs();
      return { scheduled: true };
    }

    const { language, conversationId, userId } = job.data;
    const message = getReminder(language || 'es');
    await chatwootClient.sendMessage(conversationId, message);
    logger.info({ userId, conversationId }, 'Daily food log reminder sent');
    return { sent: true };
  },
  {
    connection: redis,
    concurrency: 5,
    lockDuration: 60000,
  },
);

// Schedule reminder cron — runs at REMINDER_CRON_HOUR daily (default 7pm)
const reminderCronHour = parseInt(process.env.REMINDER_CRON_HOUR || '19', 10);
reminderQueue.add('schedule-reminders', {}, {
  repeat: { pattern: `0 ${reminderCronHour} * * *` },
  jobId: 'daily-reminder-scheduler',
}).then(() => {
  logger.info({ cronHour: reminderCronHour }, 'Daily reminder cron scheduled');
}).catch(err => {
  logger.error({ err }, 'Failed to schedule reminder cron');
});

reminderWorker.on('ready', () => {
  logger.info({ queue: REMINDER_QUEUE_NAME }, 'Reminder worker ready');
});

reminderWorker.on('failed', (job: Job | undefined, err: Error) => {
  logger.error({ jobId: job?.id, error: err.message }, 'Reminder job failed');
});

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
    await reminderWorker.close();
    await digestQueue.close();
    await reminderQueue.close();
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
