/**
 * Plato Inteligente — Nightly Summary Approval Routes
 *
 * GET  /api/nightly/:userId/pending     — Get pending summary for a user
 * POST /api/nightly/:summaryId/approve  — Generate PDF + send via WhatsApp + mark sent
 * POST /api/nightly/:summaryId/discard  — Discard the pending summary
 */

import { FastifyInstance } from 'fastify';
import { db } from '../../infra/db/client';
import { logger } from '../../infra/logging/logger';
import { generateSummaryPdf } from '../../domain/pdf/generator';
import { ChatwootClient } from '../../adapters/chatwoot/client';

const chatwootClient = new ChatwootClient();

export async function nightlyRoutes(app: FastifyInstance) {

  // ── GET /api/nightly/:userId/pending ──────────────────────────────────────
  app.get('/:userId/pending', async (request, reply) => {
    const { userId } = request.params as { userId: string };

    try {
      const result = await db.query(
        `SELECT ns.id, ns.user_id, ns.digest_id, ns.html_content, ns.digest_data,
                ns.status, ns.digest_date, ns.created_at,
                u.name, u.language
         FROM nightly_summaries ns
         JOIN users u ON u.id = ns.user_id
         WHERE ns.user_id = $1 AND ns.status = 'pending'
         ORDER BY ns.digest_date DESC
         LIMIT 1`,
        [userId],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'No pending summary' });
      }

      const row = result.rows[0];
      return reply.send({
        success: true,
        summary: {
          id: row.id,
          userId: row.user_id,
          digestId: row.digest_id,
          htmlContent: row.html_content,
          digestData: row.digest_data,
          status: row.status,
          digestDate: row.digest_date,
          createdAt: row.created_at,
          userName: row.name,
          language: row.language,
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ── POST /api/nightly/:summaryId/approve ──────────────────────────────────
  // Generate PDF from stored HTML → send via WhatsApp → mark as sent
  app.post('/:summaryId/approve', async (request, reply) => {
    const { summaryId } = request.params as { summaryId: string };

    try {
      // 1. Load the summary
      const summaryResult = await db.query(
        `SELECT ns.*, u.phone, u.name, u.language,
                cs.conversation_id
         FROM nightly_summaries ns
         JOIN users u ON u.id = ns.user_id
         LEFT JOIN conversation_state cs ON cs.user_id = ns.user_id
         WHERE ns.id = $1`,
        [summaryId],
      );

      if (summaryResult.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Summary not found' });
      }

      const summary = summaryResult.rows[0];

      if (summary.status === 'sent') {
        return reply.status(409).send({ success: false, error: 'Summary already sent' });
      }

      // 2. Mark as approved
      await db.query(
        `UPDATE nightly_summaries SET status = 'approved', approved_at = NOW() WHERE id = $1`,
        [summaryId],
      );

      // 3. Find conversation ID
      const conversationId = summary.conversation_id
        || await chatwootClient.findConversationByPhone(summary.phone);

      if (!conversationId) {
        return reply.status(404).send({ success: false, error: 'No Chatwoot conversation found for this user' });
      }

      // 4. Generate PDF from stored digest_data
      let pdfSent = false;
      const digestData = typeof summary.digest_data === 'string'
        ? JSON.parse(summary.digest_data)
        : summary.digest_data;

      try {
        const pdfBuffer = await generateSummaryPdf(digestData);
        const userName = (digestData.greeting_name as string || summary.name || 'User').replace(/\s+/g, '_');
        const dateStr = String(summary.digest_date).split('T')[0];
        const fileName = `Plato_Inteligente_${userName}_${dateStr}.pdf`;

        await chatwootClient.sendAttachment(
          conversationId,
          pdfBuffer,
          fileName,
          '📋 Tu resumen nocturno está listo. Ábrelo para ver tu análisis completo de hoy.',
        );
        pdfSent = true;
        logger.info({ summaryId, userId: summary.user_id, fileName }, 'PDF approved and sent via WhatsApp');
      } catch (pdfErr) {
        const err = pdfErr instanceof Error ? pdfErr : new Error(String(pdfErr));
        logger.warn({ error: err.message, summaryId }, 'PDF generation failed on approve');
        return reply.status(500).send({ success: false, error: `PDF generation failed: ${err.message}` });
      }

      // 5. Mark as sent
      await db.query(
        `UPDATE nightly_summaries SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [summaryId],
      );

      return reply.send({ success: true, pdfSent, conversationId });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ error: err.message, summaryId }, 'Approve failed');
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ── POST /api/nightly/:summaryId/discard ──────────────────────────────────
  app.post('/:summaryId/discard', async (request, reply) => {
    const { summaryId } = request.params as { summaryId: string };

    try {
      const result = await db.query(
        `UPDATE nightly_summaries SET status = 'discarded' WHERE id = $1 AND status = 'pending' RETURNING id`,
        [summaryId],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Summary not found or already processed' });
      }

      return reply.send({ success: true });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}
