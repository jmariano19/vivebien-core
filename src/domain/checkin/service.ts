import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { CheckinStatus, CheckinState } from '../../shared/types';
import { logger } from '../../infra/logging/logger';
import { ChatwootClient } from '../../adapters/chatwoot/client';

// 24 hours in milliseconds
const CHECKIN_DELAY_MS = 24 * 60 * 60 * 1000;

// 6 hours - if conversation active within this window, skip check-in
const ACTIVE_CONVERSATION_WINDOW_MS = 6 * 60 * 60 * 1000;

export class CheckinService {
  private chatwootClient: ChatwootClient;

  constructor(
    private db: Pool,
    private checkinQueue: Queue
  ) {
    this.chatwootClient = new ChatwootClient();
  }

  // ============================================================================
  // Message Templates
  // ============================================================================

  private getCheckinMessage(name: string | null, caseLabel: string | null, language: string): string {
    const templates: Record<string, { withName: string; withoutName: string }> = {
      es: {
        withName: `Hola {name} 👋

Solo quería ver cómo sigues.

¿Cómo se siente ${caseLabel || 'tu síntoma'} hoy comparado con ayer?

Si algo ha cambiado, puedo agregarlo a tu registro.`,
        withoutName: `Hola 👋

Solo quería ver cómo sigues.

¿Cómo se siente ${caseLabel || 'tu síntoma'} hoy comparado con ayer?

Si algo ha cambiado, puedo agregarlo a tu registro.`,
      },
      en: {
        withName: `Hi {name} 👋

Just checking in.

How is ${caseLabel || 'your symptom'} feeling today compared to yesterday?

If anything has changed, I can add it to your note.`,
        withoutName: `Hi 👋

Just checking in.

How is ${caseLabel || 'your symptom'} feeling today compared to yesterday?

If anything has changed, I can add it to your note.`,
      },
      pt: {
        withName: `Oi {name} 👋

Só passando para ver como você está.

Como está ${caseLabel || 'seu sintoma'} hoje comparado a ontem?

Se algo mudou, posso adicionar ao seu registro.`,
        withoutName: `Oi 👋

Só passando para ver como você está.

Como está ${caseLabel || 'seu sintoma'} hoje comparado a ontem?

Se algo mudou, posso adicionar ao seu registro.`,
      },
      fr: {
        withName: `Bonjour {name} 👋

Je voulais juste prendre des nouvelles.

Comment va ${caseLabel || 'votre symptôme'} aujourd'hui par rapport à hier?

Si quelque chose a changé, je peux l'ajouter à votre dossier.`,
        withoutName: `Bonjour 👋

Je voulais juste prendre des nouvelles.

Comment va ${caseLabel || 'votre symptôme'} aujourd'hui par rapport à hier?

Si quelque chose a changé, je peux l'ajouter à votre dossier.`,
      },
    };

    const langTemplates = templates[language] || templates.en;

    if (name) {
      return langTemplates.withName.replace('{name}', name);
    }
    return langTemplates.withoutName;
  }

  private getCheckinAcknowledgment(userResponse: string, language: string): { message: string; noteEntry: string } {
    const lowerResponse = userResponse.toLowerCase();

    // Detect response type
    const isSame = /\b(same|igual|mesmo|pareil|sin cambio|no change)\b/i.test(lowerResponse);
    const isBetter = /\b(better|mejor|melhor|mieux|less pain|menos dolor|improvement|mejora)\b/i.test(lowerResponse);
    const isWorse = /\b(worse|peor|pior|pire|more pain|más dolor|swelling|hincha|empeor)\b/i.test(lowerResponse);

    const responses: Record<string, Record<string, { message: string; noteEntry: string }>> = {
      same: {
        es: {
          message: 'Entendido — he añadido que se siente más o menos igual hoy. Si cambia después, solo escríbeme y actualizo tu registro.',
          noteEntry: `Seguimiento 24h: Sin cambios significativos - "${userResponse}"`,
        },
        en: {
          message: "Got it — I've added that it feels about the same today. If it changes later, just message me and I'll update your note.",
          noteEntry: `24h follow-up: No significant changes - "${userResponse}"`,
        },
        pt: {
          message: 'Entendi — adicionei que está mais ou menos igual hoje. Se mudar depois, é só me escrever que atualizo seu registro.',
          noteEntry: `Acompanhamento 24h: Sem mudanças significativas - "${userResponse}"`,
        },
        fr: {
          message: "Compris — j'ai noté que c'est à peu près pareil aujourd'hui. Si ça change plus tard, écrivez-moi et je mettrai à jour votre dossier.",
          noteEntry: `Suivi 24h: Pas de changements significatifs - "${userResponse}"`,
        },
      },
      better: {
        es: {
          message: 'Me alegra que haya mejoría — he añadido eso a tu registro. Si algo cambia después, puedes escribirme cuando quieras.',
          noteEntry: `Seguimiento 24h: Mejoría reportada - "${userResponse}"`,
        },
        en: {
          message: "Glad to hear there's some improvement — I've added that to your note. If anything changes later, you can message me anytime.",
          noteEntry: `24h follow-up: Improvement reported - "${userResponse}"`,
        },
        pt: {
          message: 'Que bom que melhorou — adicionei isso ao seu registro. Se algo mudar depois, pode me escrever a qualquer momento.',
          noteEntry: `Acompanhamento 24h: Melhora reportada - "${userResponse}"`,
        },
        fr: {
          message: "Content d'apprendre qu'il y a une amélioration — j'ai ajouté cela à votre dossier. Si quelque chose change, vous pouvez m'écrire à tout moment.",
          noteEntry: `Suivi 24h: Amélioration signalée - "${userResponse}"`,
        },
      },
      worse: {
        es: {
          message: 'Gracias por contarme — he añadido que se siente peor hoy. Si quieres, dime qué ha cambiado más (dolor, hinchazón, etc.) y lo capturo claramente.',
          noteEntry: `Seguimiento 24h: Empeoramiento reportado - "${userResponse}"`,
        },
        en: {
          message: "Thanks for letting me know — I've added that it feels worse today. If you'd like, tell me what changed most (pain, swelling, etc.) and I'll capture it clearly.",
          noteEntry: `24h follow-up: Worsening reported - "${userResponse}"`,
        },
        pt: {
          message: 'Obrigado por me contar — adicionei que está pior hoje. Se quiser, me diga o que mudou mais (dor, inchaço, etc.) e eu registro claramente.',
          noteEntry: `Acompanhamento 24h: Piora reportada - "${userResponse}"`,
        },
        fr: {
          message: "Merci de me le dire — j'ai noté que c'est pire aujourd'hui. Si vous voulez, dites-moi ce qui a le plus changé (douleur, gonflement, etc.) et je le noterai clairement.",
          noteEntry: `Suivi 24h: Aggravation signalée - "${userResponse}"`,
        },
      },
      default: {
        es: {
          message: 'Gracias por la actualización — lo he añadido a tu registro. Si algo más cambia, puedes escribirme cuando quieras.',
          noteEntry: `Seguimiento 24h: "${userResponse}"`,
        },
        en: {
          message: "Thanks for the update — I've added it to your note. If anything else changes, you can message me anytime.",
          noteEntry: `24h follow-up: "${userResponse}"`,
        },
        pt: {
          message: 'Obrigado pela atualização — adicionei ao seu registro. Se algo mais mudar, pode me escrever a qualquer momento.',
          noteEntry: `Acompanhamento 24h: "${userResponse}"`,
        },
        fr: {
          message: "Merci pour la mise à jour — je l'ai ajoutée à votre dossier. Si quelque chose d'autre change, vous pouvez m'écrire à tout moment.",
          noteEntry: `Suivi 24h: "${userResponse}"`,
        },
      },
    };

    let responseType = 'default';
    if (isSame) responseType = 'same';
    else if (isBetter) responseType = 'better';
    else if (isWorse) responseType = 'worse';

    const langResponses = responses[responseType]![language] || responses[responseType]!.en;
    return langResponses;
  }

  // ============================================================================
  // State Management
  // ============================================================================

  async getCheckinState(userId: string): Promise<CheckinState | null> {
    const result = await this.db.query<{
      checkin_status: CheckinStatus;
      checkin_scheduled_for: Date | null;
      last_summary_created_at: Date | null;
      last_user_message_at: Date | null;
      last_bot_message_at: Date | null;
      case_label: string | null;
    }>(
      `SELECT
        COALESCE(checkin_status, 'not_scheduled') as checkin_status,
        checkin_scheduled_for,
        last_summary_created_at,
        last_user_message_at,
        last_bot_message_at,
        case_label
       FROM conversation_state
       WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0]!;
    return {
      userId,
      status: row.checkin_status,
      scheduledFor: row.checkin_scheduled_for || undefined,
      lastSummaryCreatedAt: row.last_summary_created_at || undefined,
      lastUserMessageAt: row.last_user_message_at || undefined,
      lastBotMessageAt: row.last_bot_message_at || undefined,
      caseLabel: row.case_label || undefined,
    };
  }

  async updateCheckinStatus(userId: string, status: CheckinStatus, scheduledFor?: Date): Promise<void> {
    await this.db.query(
      `UPDATE conversation_state
       SET checkin_status = $1,
           checkin_scheduled_for = $2
       WHERE user_id = $3`,
      [status, scheduledFor || null, userId]
    );
  }

  async updateLastSummaryCreatedAt(userId: string, caseLabel?: string): Promise<void> {
    await this.db.query(
      `UPDATE conversation_state
       SET last_summary_created_at = NOW(),
           case_label = COALESCE($2, case_label)
       WHERE user_id = $1`,
      [userId, caseLabel || null]
    );
  }

  async updateLastUserMessageAt(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE conversation_state
       SET last_user_message_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );
  }

  async updateLastBotMessageAt(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE conversation_state
       SET last_bot_message_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );
  }

  // ============================================================================
  // Scheduling
  // ============================================================================

  /**
   * Schedule a 24-hour check-in after a summary is created
   * Called immediately after sending the post-summary handoff message
   */
  async scheduleCheckin(userId: string, conversationId: number, caseLabel?: string): Promise<void> {
    // Cancel any existing scheduled check-in
    await this.cancelExistingCheckin(userId);

    const scheduledFor = new Date(Date.now() + CHECKIN_DELAY_MS);

    // Update state
    await this.updateLastSummaryCreatedAt(userId, caseLabel);
    await this.updateCheckinStatus(userId, 'scheduled', scheduledFor);

    // Add job to queue with 24h delay
    await this.checkinQueue.add(
      'checkin',
      {
        userId,
        conversationId,
        scheduledAt: new Date().toISOString(),
      },
      {
        delay: CHECKIN_DELAY_MS,
        jobId: `checkin-${userId}`, // Use userId as job ID to allow easy cancellation
        removeOnComplete: true,
        removeOnFail: false,
      }
    );

    logger.info({ userId, scheduledFor, caseLabel }, '24h check-in scheduled');
  }

  /**
   * Cancel an existing scheduled check-in
   */
  async cancelExistingCheckin(userId: string): Promise<void> {
    try {
      const job = await this.checkinQueue.getJob(`checkin-${userId}`);
      if (job) {
        await job.remove();
        logger.info({ userId }, 'Existing check-in job removed');
      }
    } catch (err) {
      // Job may not exist, that's fine
      logger.debug({ userId, err }, 'No existing check-in job to remove');
    }

    await this.updateCheckinStatus(userId, 'canceled');
  }

  // ============================================================================
  // Execution
  // ============================================================================

  /**
   * Execute the check-in when the job fires
   * Returns true if message was sent, false if skipped
   */
  async executeCheckin(userId: string, conversationId: number): Promise<boolean> {
    const state = await this.getCheckinState(userId);

    if (!state) {
      logger.warn({ userId }, 'No check-in state found, skipping');
      return false;
    }

    // Check if status is still 'scheduled'
    if (state.status !== 'scheduled') {
      logger.info({ userId, status: state.status }, 'Check-in not in scheduled state, skipping');
      return false;
    }

    // Check if user sent any message after the summary was created
    if (state.lastUserMessageAt && state.lastSummaryCreatedAt) {
      if (state.lastUserMessageAt > state.lastSummaryCreatedAt) {
        logger.info({ userId }, 'User sent message after summary, canceling check-in');
        await this.updateCheckinStatus(userId, 'canceled');
        return false;
      }
    }

    // Check if there's been active conversation in the last 6 hours
    const sixHoursAgo = new Date(Date.now() - ACTIVE_CONVERSATION_WINDOW_MS);
    if (state.lastBotMessageAt && state.lastBotMessageAt > sixHoursAgo) {
      if (state.lastUserMessageAt && state.lastUserMessageAt > sixHoursAgo) {
        logger.info({ userId }, 'Active conversation in last 6h, canceling check-in');
        await this.updateCheckinStatus(userId, 'canceled');
        return false;
      }
    }

    // Get user info for personalization
    const userResult = await this.db.query<{
      name: string | null;
      language: string;
    }>(
      `SELECT name, COALESCE(language, 'en') as language FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      logger.warn({ userId }, 'User not found, skipping check-in');
      await this.updateCheckinStatus(userId, 'canceled');
      return false;
    }

    const user = userResult.rows[0]!;
    const message = this.getCheckinMessage(user.name, state.caseLabel || null, user.language);

    // Send the check-in message
    try {
      await this.chatwootClient.sendMessage(conversationId, message);
      await this.updateCheckinStatus(userId, 'sent');
      await this.updateLastBotMessageAt(userId);

      logger.info({ userId, conversationId }, '24h check-in message sent');
      return true;
    } catch (err) {
      logger.error({ userId, err }, 'Failed to send check-in message');
      throw err;
    }
  }

  /**
   * Handle user's response to a check-in
   * Returns the acknowledgment message to send, or null if not a check-in response
   */
  async handleCheckinResponse(userId: string, userMessage: string): Promise<{
    acknowledgment: string;
    noteEntry: string;
  } | null> {
    const state = await this.getCheckinState(userId);

    if (!state || state.status !== 'sent') {
      return null;
    }

    // Get user language
    const userResult = await this.db.query<{ language: string }>(
      `SELECT COALESCE(language, 'en') as language FROM users WHERE id = $1`,
      [userId]
    );
    const language = userResult.rows[0]?.language || 'en';

    const response = this.getCheckinAcknowledgment(userMessage, language);

    // Mark check-in as completed
    await this.updateCheckinStatus(userId, 'completed');

    return response;
  }

  // ============================================================================
  // Case Label Extraction
  // ============================================================================

  /**
   * Extract a simple case label from the summary for use in check-in message
   * e.g., "your eye", "your back", "your headache"
   */
  extractCaseLabel(summary: string, language: string): string | null {
    const patterns: Record<string, RegExp[]> = {
      en: [
        /\b(eye|eyes)\b/i,
        /\b(back|lower back|upper back)\b/i,
        /\b(head|headache)\b/i,
        /\b(throat)\b/i,
        /\b(stomach|abdomen)\b/i,
        /\b(chest)\b/i,
        /\b(knee|ankle|wrist|shoulder|elbow)\b/i,
        /\b(sty|stye|orzuelo)\b/i,
      ],
      es: [
        /\b(ojo|ojos)\b/i,
        /\b(espalda)\b/i,
        /\b(cabeza|dolor de cabeza)\b/i,
        /\b(garganta)\b/i,
        /\b(estómago|abdomen)\b/i,
        /\b(pecho)\b/i,
        /\b(rodilla|tobillo|muñeca|hombro|codo)\b/i,
        /\b(orzuelo)\b/i,
      ],
    };

    const langPatterns = patterns[language] || patterns.en;
    const prefixes: Record<string, string> = {
      en: 'your ',
      es: 'tu ',
      pt: 'seu ',
      fr: 'votre ',
    };

    for (const pattern of langPatterns) {
      const match = summary.match(pattern);
      if (match) {
        const prefix = prefixes[language] || prefixes.en;
        return prefix + match[0].toLowerCase();
      }
    }

    return null;
  }
}
