/**
 * Plato Inteligente — Worker Entry Point
 *
 * Workers:
 * 1. Inbound message worker (save + ack, zero AI during day)
 * 2. Check-in worker (24h follow-ups)
 * 3. Digest worker (processes manual digest jobs)
 * 4. Daily meal check-in scheduler (8 PM ET every day)
 * 5. Weekly summary scheduler (8 PM ET every Friday)
 */

import { Worker, Job, Queue } from 'bullmq';
import Anthropic from '@anthropic-ai/sdk';
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
const WEEKLY_SUMMARY_QUEUE_NAME = 'plato-weekly-summary';

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
// Daily Meal Check-in Messages
// ============================================================================

const MEAL_CHECKIN_MESSAGES: Record<string, string> = {
  es: '¿Qué comiste hoy? 🍽\n\n• *Desayuno:* ¿qué comiste?\n• *Comida:* ¿qué comiste?\n• *Cena:* ¿qué comiste?\n\nY dos señales rápidas:\n• *Energía:* alta / media / baja\n• *Sueño:* bien / regular / mal\n\nEscríbeme lo que recuerdes, aunque sea poco.',
  en: "What did you eat today? 🍽\n\n• *Breakfast:* what did you have?\n• *Lunch:* what did you have?\n• *Dinner:* what did you have?\n\nTwo quick signals:\n• *Energy:* high / medium / low\n• *Sleep:* good / ok / bad\n\nSend me whatever you remember, even if it's just a little.",
  pt: 'O que você comeu hoje? 🍽\n\n• *Café da manhã:* o que comeu?\n• *Almoço:* o que comeu?\n• *Jantar:* o que comeu?\n\nDois sinais rápidos:\n• *Energia:* alta / média / baixa\n• *Sono:* bem / regular / mal\n\nMe manda o que lembrar, mesmo que seja pouco.',
  fr: "Qu'avez-vous mangé aujourd'hui ? 🍽\n\n• *Petit-déjeuner:* qu'avez-vous mangé ?\n• *Déjeuner:* qu'avez-vous mangé ?\n• *Dîner:* qu'avez-vous mangé ?\n\nDeux signaux rapides :\n• *Énergie:* haute / moyenne / basse\n• *Sommeil:* bien / correct / mal\n\nEnvoyez-moi ce dont vous vous souvenez, même un peu.",
};

function getMealCheckin(language: string): string {
  return MEAL_CHECKIN_MESSAGES[language] ?? MEAL_CHECKIN_MESSAGES.es!;
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
// Worker 3: Nightly Digest (processes individual digest jobs queued manually)
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

      // Send summary directly via WhatsApp
      if (Object.keys(result.summaryData).length > 0 && !result.summaryData.parse_error) {
        const message = formatSummaryForWhatsApp(result.summaryData, language || 'es');
        await chatwootClient.sendMessage(conversationId, message);
        logger.info(
          { userId, eventCount: result.eventsProcessed, nightlySummaryId: result.nightlySummaryId },
          'Nightly digest sent via WhatsApp',
        );
      } else {
        logger.warn({ userId, summaryData: result.summaryData }, 'Summary empty or parse error — skipping send');
      }

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
// Digest Queue — no automatic cron; clear any stale repeat jobs on startup
// ============================================================================

const digestQueue = new Queue(DIGEST_QUEUE_NAME, { connection: redis });

digestQueue.getRepeatableJobs().then(async (jobs) => {
  for (const job of jobs) {
    await digestQueue.removeRepeatableByKey(job.key);
    logger.info({ key: job.key }, 'Removed stale digest repeat job');
  }
}).catch(err => {
  logger.error({ err }, 'Failed to clean up stale digest repeat jobs');
});

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
    const message = getMealCheckin(language || 'es');
    await chatwootClient.sendMessage(conversationId, message);
    logger.info({ userId, conversationId }, 'Daily meal check-in sent');
    return { sent: true };
  },
  {
    connection: redis,
    concurrency: 5,
    lockDuration: 60000,
  },
);

// Clear any stale repeat jobs then register the correct cron
reminderQueue.getRepeatableJobs().then(async (jobs) => {
  for (const job of jobs) {
    await reminderQueue.removeRepeatableByKey(job.key);
    logger.info({ key: job.key }, 'Removed stale reminder repeat job');
  }
  await reminderQueue.add('schedule-reminders', {}, {
    repeat: { pattern: '0 20 * * *', tz: 'America/New_York' },
    jobId: 'daily-reminder-scheduler',
  });
  logger.info({ cron: '0 20 * * * America/New_York' }, 'Daily meal check-in cron scheduled');
}).catch(err => {
  logger.error({ err }, 'Failed to schedule meal check-in cron');
});

reminderWorker.on('ready', () => {
  logger.info({ queue: REMINDER_QUEUE_NAME }, 'Reminder worker ready');
});

reminderWorker.on('failed', (job: Job | undefined, err: Error) => {
  logger.error({ jobId: job?.id, error: err.message }, 'Reminder job failed');
});

// ============================================================================
// Weekly Friday Summary — Sends meal patterns + recommendations every Friday
// ============================================================================

const weeklySummaryQueue = new Queue(WEEKLY_SUMMARY_QUEUE_NAME, { connection: redis });
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

async function generateWeeklySummary(userId: string, language: string, conversationId: number) {
  const today = new Date();
  const fourWeeksAgo = new Date(today);
  fourWeeksAgo.setDate(today.getDate() - 28);
  fourWeeksAgo.setHours(0, 0, 0, 0);

  const eventsResult = await db.query<{ event_date: string; raw_input: string; event_type: string }>(
    `SELECT event_date::text, raw_input, event_type
     FROM health_events
     WHERE user_id = $1
       AND event_date >= $2
       AND raw_input IS NOT NULL
     ORDER BY event_date, event_time`,
    [userId, fourWeeksAgo.toISOString().split('T')[0]],
  );

  if (eventsResult.rows.length === 0) {
    logger.info({ userId }, 'No events in last 4 weeks — skipping weekly summary');
    return;
  }

  // Group by week so Claude can read progression
  const weekMap = new Map<string, string[]>();
  for (const event of eventsResult.rows) {
    const date = new Date(event.event_date + 'T12:00:00');
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - (date.getDay() === 0 ? 6 : date.getDay() - 1));
    const weekKey = weekStart.toISOString().split('T')[0]!;
    if (!weekMap.has(weekKey)) weekMap.set(weekKey, []);
    weekMap.get(weekKey)!.push(`  ${event.event_date}: ${event.raw_input}`);
  }

  const weeksSorted = [...weekMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const totalWeeks = weeksSorted.length;
  const eventLines = weeksSorted
    .map(([weekStart, lines], i) => {
      const label = i === totalWeeks - 1 ? 'Esta semana' : `Semana ${i + 1}`;
      return `${label} (desde ${weekStart}):\n${lines.join('\n')}`;
    })
    .join('\n\n');

  const prompt = language === 'en'
    ? `You are a nutrition coach and research-informed advisor tracking a user across ${totalWeeks} week(s). Your goal: help them move from food awareness to reading their body signals — grounded in actual nutritional science.

Logged data (meals + body signals when reported):

${eventLines}

Write a WhatsApp summary with exactly these 4 sections:

*This week* — 2-3 specific things from this week's logs (food choices or body signals)

*Patterns I'm seeing* — signals that appeared 2+ times across weeks: energy after certain foods, sleep, nighttime hunger, recovery. Only confirm a pattern if you have 2+ data points — otherwise label it "emerging." For each confirmed pattern, include one sentence explaining the biological mechanism behind it (e.g. why protein at dinner reduces nighttime hunger, why high-starch meals cause energy crashes).

*Compared to past weeks* — one measurable shift (more protein, less starch, better sleep, fewer late snacks, etc.)

*Experiment for next week* — one small, specific change tied to an observed pattern. Include: (1) what to try, (2) the research mechanism behind why it should work — cite a study, metabolic pathway, or established finding by name, and (3) what signal to observe. Frame as a question, not a rule.

Under 350 words. *Bold* section headings. Tone: curious coach who knows the science — not a clinic report, not vague encouragement. No shame, no preamble.`
    : `Eres un coach de nutrición y asesor basado en evidencia científica, haciendo seguimiento a un usuario durante ${totalWeeks} semana(s). Tu objetivo: ayudarlo a pasar de la conciencia alimentaria a leer las señales de su cuerpo — con respaldo de ciencia nutricional real.

Datos registrados (comidas + señales del cuerpo cuando las reportó):

${eventLines}

Escribe un resumen para WhatsApp con exactamente estas 4 secciones:

*Esta semana* — 2-3 cosas específicas de los registros de esta semana (elecciones de comida o señales del cuerpo)

*Patrones que veo* — señales que aparecieron 2 o más veces entre semanas: energía después de ciertos alimentos, sueño, hambre nocturna, recuperación. Solo confirma un patrón si tienes 2 o más datos — si no, llámalo "emergente." Para cada patrón confirmado, incluye una oración explicando el mecanismo biológico detrás (ej: por qué la proteína en la cena reduce el hambre nocturna, por qué el almidón alto provoca caídas de energía).

*Comparado con semanas anteriores* — un cambio medible (más proteína, menos almidón, mejor sueño, menos snacks nocturnos, etc.)

*Experimento para la próxima semana* — un cambio pequeño y específico basado en un patrón observado. Incluye: (1) qué probar, (2) el mecanismo de investigación detrás — cita un estudio, vía metabólica o hallazgo establecido por nombre, y (3) qué señal observar como resultado. Plántalo como una pregunta, no como una regla.

Máximo 350 palabras. Títulos en *negritas*. Tono: coach curioso que conoce la ciencia — no un informe clínico, no motivación vaga. Sin vergüenza, sin preámbulo.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 900,
    messages: [{ role: 'user', content: prompt }],
  });

  const summary = (response.content[0] as { type: string; text: string }).text;
  const header = language === 'en'
    ? '*📊 Your Week in Review*\n\n'
    : '*📊 Tu Semana en Resumen*\n\n';

  await chatwootClient.sendMessage(conversationId, header + summary);
  logger.info({ userId, eventsCount: eventsResult.rows.length, weeksOfData: totalWeeks }, 'Weekly summary sent');
}

const weeklySummaryWorker = new Worker(
  WEEKLY_SUMMARY_QUEUE_NAME,
  async (job: Job) => {
    if (job.name === 'schedule-weekly-summaries') {
      logger.info('Running weekly summary scheduler...');

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

      const today = new Date().toISOString().split('T')[0]!;
      for (const user of usersResult.rows) {
        await weeklySummaryQueue.add('send-weekly-summary', {
          userId: user.user_id,
          language: user.language,
          conversationId: user.conversation_id,
        }, {
          jobId: `weekly-summary-${user.user_id}-${today}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 30000 },
        });
      }

      logger.info({ userCount: usersResult.rows.length }, 'Weekly summary jobs scheduled');
      return { scheduled: true };
    }

    const { userId, language, conversationId } = job.data;
    await generateWeeklySummary(userId, language || 'es', conversationId);
    return { sent: true };
  },
  {
    connection: redis,
    concurrency: 3,
    lockDuration: 120000,
  },
);

// Clear any stale repeat jobs then register the correct cron
weeklySummaryQueue.getRepeatableJobs().then(async (jobs) => {
  for (const job of jobs) {
    await weeklySummaryQueue.removeRepeatableByKey(job.key);
    logger.info({ key: job.key }, 'Removed stale weekly summary repeat job');
  }
  await weeklySummaryQueue.add('schedule-weekly-summaries', {}, {
    repeat: { pattern: '0 20 * * 5', tz: 'America/New_York' },
    jobId: 'weekly-summary-scheduler',
  });
  logger.info({ cron: '0 20 * * 5 America/New_York' }, 'Weekly Friday summary cron scheduled');
}).catch(err => {
  logger.error({ err }, 'Failed to schedule weekly summary cron');
});

weeklySummaryWorker.on('ready', () => {
  logger.info({ queue: WEEKLY_SUMMARY_QUEUE_NAME }, 'Weekly summary worker ready');
});

weeklySummaryWorker.on('failed', (job: Job | undefined, err: Error) => {
  logger.error({ jobId: job?.id, error: err.message }, 'Weekly summary job failed');
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
    await reminderWorker.close();
    await weeklySummaryWorker.close();
    await digestQueue.close();
    await reminderQueue.close();
    await weeklySummaryQueue.close();
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
