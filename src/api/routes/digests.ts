import { FastifyInstance } from 'fastify';
import { DigestService } from '../../domain/digest/service';
import { HealthEventService } from '../../domain/health-event/service';
import { ChatwootClient } from '../../adapters/chatwoot/client';
import { generateSummaryPdf } from '../../domain/pdf/generator';
import { db } from '../../infra/db/client';
import { logger } from '../../infra/logging/logger';

const digestService = new DigestService(db);
const healthEventService = new HealthEventService(db);
const chatwootClient = new ChatwootClient();

// Heads-up messages
const HEADS_UP_MESSAGES: Record<string, string> = {
  es: 'Estamos terminando tu resumen nocturno. En unos 15 minutos lo tendrás listo.\nSi algo no refleja exactamente tu día o cómo te sentiste, escríbenos aquí mismo. Lo afinamos para que cada noche sea más clara que la anterior.',
  en: "Your nightly summary is almost ready. You'll have it in about 15 minutes.\nIf anything doesn't quite match your day, just write us here. We'll fine-tune it so each night gets clearer.",
  pt: 'Seu resumo noturno está quase pronto. Em uns 15 minutos estará listo.\nSe algo não refletir exatamente seu dia, escreva aqui. Ajustamos para que cada noite seja mais clara.',
  fr: "Votre résumé nocturne est presque prêt. Dans environ 15 minutes il sera là.\nSi quelque chose ne reflète pas votre journée, écrivez-nous ici. On ajuste pour que chaque soir soit plus clair.",
};

export async function digestRoutes(app: FastifyInstance) {
  // GET /api/digests/:userId/latest
  app.get('/:userId/latest', async (request, reply) => {
    const { userId } = request.params as { userId: string };

    try {
      const digest = await digestService.getDigest(userId, new Date().toISOString().split('T')[0]!);
      if (!digest) {
        return reply.status(404).send({ success: false, error: 'No digests found' });
      }
      return reply.send({ success: true, digest });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // GET /api/digests/:userId?date=YYYY-MM-DD
  app.get('/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const { date } = request.query as { date?: string };

    try {
      if (date) {
        const digest = await digestService.getDigest(userId, date);
        if (!digest) {
          return reply.status(404).send({ success: false, error: `No digest found for ${date}` });
        }
        return reply.send({ success: true, digest });
      }
      return reply.send({ success: true, message: 'Provide ?date=YYYY-MM-DD' });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // POST /api/digests/:userId/generate — Generate digest only (no WhatsApp delivery)
  app.post('/:userId/generate', async (request, reply) => {
    const { userId } = request.params as { userId: string };

    try {
      const userResult = await db.query<{ language: string; name: string | null }>(
        'SELECT language, name FROM users WHERE id = $1',
        [userId],
      );

      if (userResult.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'User not found' });
      }

      const user = userResult.rows[0]!;
      const result = await digestService.generateDigest(
        userId,
        new Date(),
        user.language,
        user.name || undefined,
      );

      return reply.send({
        success: true,
        digest: result.digest,
        eventsProcessed: result.eventsProcessed,
        summaryData: result.summaryData,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/digests/:userId/trigger-nightly
   *
   * Manually trigger the FULL nightly sequence:
   * 1. Send heads-up message
   * 2. Generate digest (Haiku)
   * 3. Send summary via WhatsApp
   *
   * Use for testing — skips the 15 min delay.
   */
  app.post('/:userId/trigger-nightly', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const { skipHeadsUp } = (request.body as { skipHeadsUp?: boolean }) || {};

    try {
      // 1. Load user
      const userResult = await db.query<{ language: string; name: string | null }>(
        'SELECT language, name FROM users WHERE id = $1',
        [userId],
      );

      if (userResult.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'User not found' });
      }

      const user = userResult.rows[0]!;

      // 2. Find their conversation via Chatwoot API (look up by phone)
      const phoneResult = await db.query<{ phone: string }>(
        'SELECT phone FROM users WHERE id = $1',
        [userId],
      );
      const phone = phoneResult.rows[0]?.phone;
      if (!phone) {
        return reply.status(404).send({ success: false, error: 'No phone number found for user' });
      }

      const conversationId = await chatwootClient.findConversationByPhone(phone);
      if (!conversationId) {
        return reply.status(404).send({ success: false, error: 'No conversation found in Chatwoot for this user' });
      }

      // 3. Check for events
      const today = new Date().toISOString().split('T')[0]!;
      const events = await healthEventService.getUnprocessedEvents(userId, today);

      if (events.length === 0) {
        return reply.send({ success: false, error: 'No unprocessed events today', eventsCount: 0 });
      }

      // 4. Send heads-up (optional)
      if (!skipHeadsUp) {
        const headsUpMsg = HEADS_UP_MESSAGES[user.language] || HEADS_UP_MESSAGES.es!;
        await chatwootClient.sendMessage(conversationId, headsUpMsg);
      }

      // 5. Generate digest
      const result = await digestService.generateDigest(
        userId,
        new Date(),
        user.language,
        user.name || undefined,
      );

      // 6. Generate PDF and send via WhatsApp
      let pdfSent = false;
      if (result.summaryData && Object.keys(result.summaryData).length > 0) {
        // Try to generate branded PDF
        try {
          const pdfBuffer = await generateSummaryPdf(result.summaryData);
          if (pdfBuffer) {
            const userName = ((result.summaryData as Record<string, unknown>).greeting_name as string || user.name || 'User').replace(/\s+/g, '_');
            const dateStr = new Date().toISOString().split('T')[0];
            const fileName = `Plato_Inteligente_${userName}_${dateStr}.pdf`;
            await chatwootClient.sendAttachment(
              conversationId,
              pdfBuffer,
              fileName,
              '📋 Tu resumen nocturno está listo. Ábrelo para ver tu análisis completo de hoy.',
            );
            pdfSent = true;
            logger.info({ userId, fileName }, 'PDF summary sent via WhatsApp');
          }
        } catch (pdfError) {
          const pdfErr = pdfError instanceof Error ? pdfError : new Error(String(pdfError));
          logger.warn({ error: pdfErr.message, userId }, 'PDF generation failed, falling back to text');
        }

        // Fallback: send text summary if PDF failed
        if (!pdfSent) {
          const summaryText = formatSummaryForWhatsApp(result.summaryData, user.language);
          await chatwootClient.sendMessage(conversationId, summaryText);
        }
      }

      return reply.send({
        success: true,
        eventsProcessed: result.eventsProcessed,
        digest: result.digest,
        summaryData: result.summaryData,
        deliveredTo: conversationId,
        pdfSent,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      request.log.error({ error: err.message, userId }, 'Manual nightly trigger failed');
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/digests/events/:userId — View today's health events for a user
   */
  app.get('/events/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const { date } = request.query as { date?: string };

    try {
      const targetDate = date || new Date().toISOString().split('T')[0]!;
      const events = await healthEventService.getUnprocessedEvents(userId, targetDate);

      return reply.send({
        success: true,
        date: targetDate,
        count: events.length,
        events,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}

// ============================================================================
// WhatsApp formatter (same as in worker/index.ts)
// ============================================================================

function formatSummaryForWhatsApp(
  data: Record<string, unknown>,
  language: string,
): string {
  const lines: string[] = [];

  lines.push('_La comida y tu estilo de vida son medicina — con verdad y entendimiento._');
  lines.push('');

  const name = (data.greeting_name as string) || '';
  lines.push(`*${name}, tu día tiene un patrón. Hoy lo hicimos visible.*`);
  lines.push(`Día ${data.day_number || 1} — ${data.date || ''}`);
  lines.push('');

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

  if (data.willpower_text) {
    lines.push('*💪 ESTO NO ES FUERZA DE VOLUNTAD*');
    lines.push(data.willpower_text as string);
    lines.push('');
  }

  if (data.advantage_text) {
    lines.push('*⚡ TU VENTAJA METABÓLICA*');
    lines.push(data.advantage_text as string);
    lines.push('');
  }

  if (data.pattern_text) {
    lines.push('*🔍 PATRÓN EMERGENTE*');
    lines.push(data.pattern_text as string);
    lines.push('');
  }

  const questions = (data.questions as Array<{ question: string; answer: string }>) || [];
  if (questions.length > 0) {
    lines.push('*❓ TUS PREGUNTAS*');
    for (const q of questions) {
      lines.push(`_Tu preguntaste: "${q.question}"_`);
      lines.push(q.answer);
      lines.push('');
    }
  }

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

  lines.push('_No estás haciendo dieta. Estás aprendiendo a leer tu biología._');
  lines.push('');
  lines.push('Revisión: Dra. Hernández | Tu Plato Inteligente');

  return lines.join('\n');
}
