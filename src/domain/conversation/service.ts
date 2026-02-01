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
    // Get conversation state and user language in parallel
    const [stateResult, userResult] = await Promise.all([
      this.db.query<{
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
      ),
      this.db.query<{ language: string }>(
        `SELECT language FROM users WHERE id = $1`,
        [userId]
      ),
    ]);

    const state = stateResult.rows[0] || {
      phase: 'onboarding' as ConversationPhase,
      onboarding_step: 0,
      message_count: 0,
      last_message_at: null,
      prompt_version: 'v1',
      metadata: {},
    };

    const userLanguage = userResult.rows[0]?.language;

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
      language: userLanguage,
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

    // Add health record context if available
    if (healthSummary) {
      messages.push({
        role: 'assistant',
        content: `[Confianza - Registro actual del usuario]:\n${healthSummary}`,
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
    aiService: { generateSummary: (messages: Message[], currentSummary: string | null, language?: string) => Promise<string> }
  ): Promise<void> {
    // Get current summary and user language
    const [currentSummary, userResult] = await Promise.all([
      this.getHealthSummary(userId),
      this.db.query<{ language: string }>(`SELECT language FROM users WHERE id = $1`, [userId]),
    ]);

    const userLanguage = userResult.rows[0]?.language;

    // Get recent messages for context
    const recentMessages = await this.getRecentMessages(userId, 20);

    // Add the new exchange
    const allMessages = [
      ...recentMessages,
      { role: 'user' as const, content: userMessage },
      { role: 'assistant' as const, content: assistantResponse },
    ];

    // Generate updated summary using AI (with language preference)
    const newSummary = await aiService.generateSummary(allMessages, currentSummary, userLanguage);

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
    const lowerMessage = message.toLowerCase();

    // RED FLAGS - Medical emergencies requiring urgent care
    const emergencyKeywords = [
      // Cardiac
      'chest pain', 'dolor de pecho', 'dolor en el pecho', 'heart attack', 'ataque al corazón',
      'can\'t breathe', 'no puedo respirar', 'difficulty breathing', 'dificultad para respirar',
      'severe shortness of breath', 'falta de aire severa',
      // Neurological
      'stroke', 'derrame', 'can\'t move', 'no puedo mover', 'face drooping', 'cara caída',
      'slurred speech', 'habla arrastrada', 'sudden confusion', 'confusión repentina',
      'worst headache', 'peor dolor de cabeza', 'sudden numbness', 'entumecimiento repentino',
      // Pregnancy emergencies
      'heavy bleeding pregnant', 'sangrado abundante embarazada', 'severe abdominal pain pregnant',
      // Other emergencies
      'unconscious', 'inconsciente', 'seizure', 'convulsión', 'severe allergic', 'alergia severa',
      'anaphylaxis', 'anafilaxia', 'overdose', 'sobredosis',
    ];

    const isEmergency = emergencyKeywords.some((keyword) =>
      lowerMessage.includes(keyword)
    );

    if (isEmergency) {
      return {
        isUrgent: true,
        type: 'medical_emergency',
        confidence: 0.95,
        action: 'recommend_urgent_care',
      };
    }

    // Crisis/mental health keywords
    const crisisKeywords = [
      'suicid', 'matar', 'morir', 'acabar con mi vida',
      'no quiero vivir', 'quitarme la vida', 'hacerme daño',
      'suicide', 'kill myself', 'end my life', 'hurt myself',
      'want to die', 'quiero morir',
    ];

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

    // Self-harm indicators
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

  async getSystemPrompt(context: ConversationContext, userLanguage?: string): Promise<string> {
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

    // Add language adaptation instruction
    prompt += `\n\nLANGUAGE ADAPTATION
Detect the language the user writes in and respond in the same language.
If user writes in Spanish, respond in Spanish.
If user writes in English, respond in English.
If user writes in Portuguese, respond in Portuguese.
Always match the user's language exactly.
${userLanguage ? `User's stored preference: ${userLanguage}` : ''}`;

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
        es: 'Tu registro de Confianza requiere créditos adicionales. Visita la web para continuar.',
        en: 'Your Confianza record requires additional credits. Visit the website to continue.',
      },
      error: {
        es: 'No se pudo procesar tu entrada. Intenta de nuevo.',
        en: 'Could not process your entry. Try again.',
      },
      maintenance: {
        es: 'Confianza no está disponible temporalmente. Vuelve pronto.',
        en: 'Confianza is temporarily unavailable. Return soon.',
      },
      // Step 1: 3-Message Open (Value First)
      onboarding_greeting: {
        es: 'Hola. Soy Confianza, un sistema de IA.',
        en: 'Hi. I\'m Confianza, an AI system.',
      },
      onboarding_boundary: {
        es: 'No reemplazo a los médicos. Te ayudo a prepararte para ellos.',
        en: 'I don\'t replace doctors. I help you prepare for them.',
      },
      onboarding_invitation: {
        es: 'Cuéntame qué ha estado pasando y lo organizaré para tu próxima visita.',
        en: 'Tell me what\'s been happening and I\'ll organize it for your next visit.',
      },
      // Step 2: Micro-Capture Questions
      micro_what: {
        es: '¿Qué está pasando?',
        en: 'What\'s going on?',
      },
      micro_when: {
        es: '¿Cuándo comenzó?',
        en: 'When did it start?',
      },
      micro_pattern: {
        es: '¿Qué lo mejora o empeora?',
        en: 'What makes it better or worse?',
      },
      // Step 4: Name Request (After Value)
      ask_name: {
        es: '¿Cómo te gustaría que te llame? (Puedes omitir esto si prefieres.)',
        en: 'What would you like me to call you? (You can skip this if you prefer.)',
      },
      // Step 5: Trust & Control
      trust_message: {
        es: 'Tú controlas lo que registras. Tú decides qué compartir. Si algo es urgente, te lo diré.',
        en: 'You control what you log. You decide what to share. If something is urgent, I\'ll say so.',
      },
      // Step 6: 3 Rails
      three_rails: {
        es: `¿Qué te gustaría hacer?

1. Seguir registrando síntomas o cambios
2. Preparar para una visita (preguntas, cronología)
3. Generar un resumen para compartir

Responde 1, 2 o 3.`,
        en: `What would you like to do?

1. Keep logging symptoms or changes
2. Prepare for a visit (questions, timeline)
3. Generate a summary to share

Reply 1, 2, or 3.`,
      },
      // Safety: Urgent Care
      urgent_care: {
        es: `Estos síntomas pueden necesitar atención urgente. Te recomiendo que contactes a un servicio de emergencias o vayas a urgencias ahora.

Si quieres, puedo preparar un resumen de lo que me has contado para que se lo muestres al médico.`,
        en: `These symptoms may need urgent attention. I recommend you contact emergency services or go to urgent care now.

If you'd like, I can prepare a summary of what you've told me to show the clinician.`,
      },
      logged: {
        es: 'Registrado.',
        en: 'Logged.',
      },
    };

    return templates[key]?.[language] || templates[key]?.es || '';
  }

  private getDefaultSystemPrompt(): string {
    return `You are Confianza, an AI health companion.

DEFINITION
Confianza: A trusted companion that helps you track and prepare what matters for your health visits.
Primary Output: Clear, doctor-ready summaries and timelines.

ROLE / IDENTITY
- You are Confianza, an AI health companion.
- You are not human and not a clinician.
- You do not diagnose or replace doctors.
- Your role is to capture, organize, and summarize what happens between visits so users arrive prepared.
- You build trust through consistent, helpful presence.

CORE MISSION (NON-NEGOTIABLE)
Become the most trusted companion for turning what happens between doctor visits into clear, doctor-ready summaries.

Every response must do at least one of:
1. Capture relevant health context
2. Improve or update a summary
3. Help prepare for a visit (questions, timeline, changes)
4. Escalate to urgent care if symptoms are concerning

Anything outside this mission is deprioritized or refused.

TONE & STYLE
- Warm, calm, and trustworthy
- Short WhatsApp-friendly messages
- One question at a time
- Genuine care without theatrical empathy
- Honest about being AI
- Conversational but professional
- Match user language (Spanish/English/Portuguese)
- Minimal emojis (occasional 👋 for greeting is okay)

ONBOARDING FLOW (For new users or "Hi/Hola/Hello")

Step 1 — 3-Message Open (Value First)
In max 3 short messages:
1. Greeting + identity ("I'm Confianza. I'm an AI companion for your health." / "Soy Confianza. Soy un compañero de IA para tu salud.")
2. Boundary ("I don't replace doctors — I help you prepare for them." / "No reemplazo a los médicos — te ayudo a prepararte para ellos.")
3. Invitation ("Tell me what's been happening and I'll organize it for your next visit." / "Cuéntame qué ha estado pasando y lo organizaré para tu próxima visita.")

No disclaimers dump. No name request yet.

Step 2 — Micro-Capture (1–3 minutes)
Ask up to 3 simple questions, one at a time:
- What's going on? / ¿Qué está pasando?
- When did it start? / ¿Cuándo comenzó?
- What makes it better or worse? / ¿Qué lo mejora o empeora?

Rules:
- Skip questions already answered.
- If multiple issues, ask user to pick the most important one first.

Step 3 — Immediate "Aha" Output
After micro-capture, immediately generate a mini doctor-ready summary.
Format (short, neutral):
- Main concern
- Onset / duration
- Pattern / severity (if known)
- What helps / worsens
- 1–3 questions for the visit

This early summary is the value moment.

Step 4 — Name (Only After Value)
After delivering the mini-summary:
- Ask for the user's name with consent framing
- Never insist; proceed without name if they decline

Step 5 — Trust & Control (Short)
Brief reassurance (2–4 lines max):
- User controls what they log
- They choose what to share
- Urgent symptoms → you will say so

No legal or policy language.

Step 6 — Clear Next Paths (3 Rails)
Offer exactly three options:
1. Keep logging symptoms/changes
2. Prepare for a visit (questions, timeline)
3. Generate a clean, shareable summary

User replies with 1 / 2 / 3.

SAFETY (ALWAYS ON)
Continuously scan for red flags:
- Chest pain, severe shortness of breath
- Neurological symptoms (face drooping, slurred speech, sudden confusion)
- Pregnancy emergencies
- Self-harm or suicidal thoughts

If present:
- Interrupt normal flow
- Recommend urgent care clearly and calmly
- Optionally offer a "what to tell the clinician" note

OUTPUT STANDARD (DOCTOR-READY SUMMARIES)
When generating summaries:
- Neutral, clinical language
- No diagnosis certainty
- Never invent data
- Omit unknowns or mark "not provided"
- Concise, scannable bullets

FINAL INTERNAL CHECK (Before Every Message)
Ask:
1. Does this move toward a clearer summary or safer care?
2. Is it WhatsApp-short?
3. Did I avoid pretending to be human or clinical?
4. Did I provide value quickly?
5. Does my response feel trustworthy?

If not → revise.`;
  }
}
