import { Pool } from 'pg';
import {
  ConversationContext,
  ConversationPhase,
  Message,
  SafetyCheckResult,
} from '../../shared/types';
import { getActivePrompt, getConfigTemplate, getFeatureFlag } from '../../infra/db/client';

export class ConversationService {
  constructor(private db: Pool) {}

  async loadContext(userId: string, conversationId: number): Promise<ConversationContext> {
    // Get conversation state
    const stateResult = await this.db.query<{
      phase: ConversationPhase;
      onboarding_step: number | null;
      message_count: number;
      last_message_at: Date | null;
      prompt_version: string;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT phase, onboarding_step, message_count, last_message_at, prompt_version, metadata
       FROM conversation_state
       WHERE user_id = $1`,
      [userId]
    );

    const state = stateResult.rows[0] || {
      phase: 'onboarding' as ConversationPhase,
      onboarding_step: 0,
      message_count: 0,
      last_message_at: null,
      prompt_version: 'v1',
      metadata: {},
    };

    // Get experiment variants for this user
    const experiments = await this.getExperimentVariants(userId);

    return {
      userId,
      conversationId,
      phase: state.phase,
      onboardingStep: state.onboarding_step || undefined,
      messageCount: state.message_count,
      lastMessageAt: state.last_message_at || undefined,
      promptVersion: state.prompt_version || 'v1',
      experimentVariants: experiments,
      metadata: state.metadata || {},
    };
  }

  async getRecentMessages(userId: string, limit: number = 10): Promise<Message[]> {
    const result = await this.db.query<{
      role: 'user' | 'assistant';
      content: string;
      created_at: Date;
    }>(
      `SELECT role, content, created_at
       FROM messages
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    // Return in chronological order
    return result.rows.reverse().map((row) => ({
      role: row.role,
      content: row.content,
      timestamp: row.created_at,
    }));
  }

  async buildMessages(context: ConversationContext, newMessage: string): Promise<Message[]> {
    // Load recent conversation history
    const recentMessages = await this.getRecentMessages(context.userId, 10);

    // Load current health summary for context
    const healthSummary = await this.getHealthSummary(context.userId);

    // Build the message array with history
    const messages: Message[] = [];

    // Add health context as a system-level memory if available
    if (healthSummary) {
      messages.push({
        role: 'assistant',
        content: `[Contexto del usuario - Resumen de salud actualizado]:\n${healthSummary}`,
      });
    }

    // Add recent conversation history
    messages.push(...recentMessages);

    // Add the new message
    messages.push({ role: 'user', content: newMessage });

    return messages;
  }

  async getHealthSummary(userId: string): Promise<string | null> {
    const result = await this.db.query<{ content: string }>(
      `SELECT content FROM memories
       WHERE user_id = $1 AND category = 'health_summary'
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    return result.rows[0]?.content || null;
  }

  async updateHealthSummary(
    userId: string,
    userMessage: string,
    assistantResponse: string,
    aiService: { generateSummary: (messages: Message[], currentSummary: string | null) => Promise<string> }
  ): Promise<void> {
    // Get current summary
    const currentSummary = await this.getHealthSummary(userId);

    // Get recent messages for context
    const recentMessages = await this.getRecentMessages(userId, 20);

    // Add the new exchange
    const allMessages = [
      ...recentMessages,
      { role: 'user' as const, content: userMessage },
      { role: 'assistant' as const, content: assistantResponse },
    ];

    // Generate updated summary using AI
    const newSummary = await aiService.generateSummary(allMessages, currentSummary);

    // Upsert the summary (check if exists, then insert or update)
    const existing = await this.db.query(
      `SELECT id FROM memories WHERE user_id = $1 AND category = 'health_summary'`,
      [userId]
    );

    if (existing.rows.length > 0) {
      await this.db.query(
        `UPDATE memories SET content = $1, created_at = NOW(), access_count = access_count + 1
         WHERE user_id = $2 AND category = 'health_summary'`,
        [newSummary, userId]
      );
    } else {
      await this.db.query(
        `INSERT INTO memories (id, user_id, content, category, importance_score, created_at, access_count)
         VALUES (gen_random_uuid(), $1, $2, 'health_summary', 1.0, NOW(), 0)`,
        [userId, newSummary]
      );
    }
  }

  async saveMessages(
    userId: string,
    conversationId: number,
    messages: Message[]
  ): Promise<void> {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      for (const message of messages) {
        await client.query(
          `INSERT INTO messages (id, user_id, conversation_id, role, content, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())`,
          [userId, conversationId, message.role, message.content]
        );
      }

      // Update message count
      await client.query(
        `UPDATE conversation_state
         SET message_count = message_count + $1,
             last_message_at = NOW()
         WHERE user_id = $2`,
        [messages.length, userId]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateState(userId: string, context: ConversationContext): Promise<void> {
    // Determine if phase should change
    const newPhase = this.determineNextPhase(context);

    await this.db.query(
      `UPDATE conversation_state
       SET phase = $1,
           onboarding_step = $2,
           metadata = $3
       WHERE user_id = $4`,
      [
        newPhase,
        context.onboardingStep,
        JSON.stringify(context.metadata),
        userId,
      ]
    );
  }

  async checkSafety(message: string, context: ConversationContext): Promise<SafetyCheckResult> {
    // Check for crisis keywords
    const crisisKeywords = [
      'suicid', 'matar', 'morir', 'acabar con mi vida',
      'no quiero vivir', 'quitarme la vida', 'hacerme daño',
      'suicide', 'kill myself', 'end my life', 'hurt myself',
    ];

    const lowerMessage = message.toLowerCase();
    const isCrisis = crisisKeywords.some((keyword) =>
      lowerMessage.includes(keyword)
    );

    if (isCrisis) {
      return {
        isUrgent: true,
        type: 'crisis',
        confidence: 0.9,
        action: 'escalate_to_crisis_protocol',
      };
    }

    // Check for self-harm indicators
    const selfHarmKeywords = [
      'cortarme', 'lastimarme', 'golpearme',
      'cut myself', 'hurt myself', 'harm myself',
    ];

    const isSelfHarm = selfHarmKeywords.some((keyword) =>
      lowerMessage.includes(keyword)
    );

    if (isSelfHarm) {
      return {
        isUrgent: true,
        type: 'self_harm',
        confidence: 0.8,
        action: 'provide_resources',
      };
    }

    return {
      isUrgent: false,
      confidence: 1.0,
    };
  }

  async getTemplate(key: string, language: 'es' | 'en' = 'es'): Promise<string> {
    const template = await getConfigTemplate(key, language);
    return template || this.getDefaultTemplate(key, language);
  }

  async getSystemPrompt(context: ConversationContext): Promise<string> {
    // Get base system prompt
    const basePrompt = await getActivePrompt('system');

    // Get phase-specific prompt
    const phasePrompt = await getActivePrompt(`${context.phase}`);

    // Combine prompts
    let prompt = basePrompt || this.getDefaultSystemPrompt();

    if (phasePrompt) {
      prompt += '\n\n' + phasePrompt;
    }

    // Apply experiment variants
    for (const [key, variant] of Object.entries(context.experimentVariants)) {
      const variantPrompt = await getActivePrompt(`${key}_${variant}`);
      if (variantPrompt) {
        prompt += '\n\n' + variantPrompt;
      }
    }

    return prompt;
  }

  private async getExperimentVariants(userId: string): Promise<Record<string, string>> {
    const result = await this.db.query<{
      experiment_key: string;
      variant: string;
    }>(
      `SELECT experiment_key, variant
       FROM experiment_assignments
       WHERE user_id = $1`,
      [userId]
    );

    return result.rows.reduce((acc, row) => {
      acc[row.experiment_key] = row.variant;
      return acc;
    }, {} as Record<string, string>);
  }

  private determineNextPhase(context: ConversationContext): ConversationPhase {
    // Simple phase transition logic
    if (context.phase === 'onboarding') {
      // Move to active after 5 messages
      if (context.messageCount >= 5) {
        return 'active';
      }
    }

    return context.phase;
  }

  private getDefaultTemplate(key: string, language: 'es' | 'en'): string {
    const templates: Record<string, Record<string, string>> = {
      no_credits: {
        es: 'Lo siento, no tienes créditos disponibles. Visita nuestra web para obtener más.',
        en: "Sorry, you don't have any credits available. Visit our website to get more.",
      },
      error: {
        es: 'Lo siento, ocurrió un error. Por favor intenta de nuevo.',
        en: 'Sorry, an error occurred. Please try again.',
      },
      maintenance: {
        es: 'Estamos en mantenimiento. Volvemos pronto.',
        en: 'We are under maintenance. We will be back soon.',
      },
    };

    return templates[key]?.[language] || templates[key]?.es || '';
  }

  private getDefaultSystemPrompt(): string {
    return `Eres un asistente de bienestar emocional llamado ViveBien.
Tu objetivo es ayudar a las personas a mejorar su bienestar mental y emocional.
Responde siempre en español a menos que el usuario escriba en otro idioma.
Sé empático, comprensivo y ofrece apoyo constructivo.
Nunca des consejos médicos específicos - recomienda consultar a un profesional cuando sea apropiado.`;
  }
}
