import { Pool } from 'pg';
import {
  ConversationContext,
  ConversationPhase,
  Message,
  SafetyCheckResult,
} from '../../shared/types';
import { getActivePrompt, getConfigTemplate, getFeatureFlag } from '../../infra/db/client';
import { ConcernService } from '../concern/service';

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

    // Load active health concerns for context (multi-concern aware)
    const concernService = new ConcernService(this.db);
    let healthContext: string | null = null;

    try {
      const activeConcerns = await concernService.getActiveConcerns(context.userId);

      if (activeConcerns.length > 0) {
        const concernLines = activeConcerns.map((c, i) => {
          const statusLabel = c.status === 'improving' ? 'Improving' : 'Active';
          const preview = c.summaryContent
            ? c.summaryContent.split('\n')[0]?.substring(0, 80)
            : 'No details yet';
          return `${i + 1}. ${c.title} (${statusLabel}) - ${preview}`;
        });
        healthContext = `[CareLog - Active health concerns]:\n${concernLines.join('\n')}`;
      }
    } catch {
      // Fallback to old single-summary if health_concerns table doesn't exist yet
      const healthSummary = await this.getHealthSummary(context.userId);
      if (healthSummary) {
        healthContext = `[CareLog - Current health record]:\n${healthSummary}`;
      }
    }

    // Build the message array with history
    const messages: Message[] = [];

    // Add health record context if available
    if (healthContext) {
      messages.push({
        role: 'assistant',
        content: healthContext,
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
    aiService: {
      generateSummary: (messages: Message[], currentSummary: string | null, language?: string) => Promise<string>;
      detectConcernTitle: (messages: Message[], language?: string) => Promise<string>;
    }
  ): Promise<void> {
    const concernService = new ConcernService(this.db);

    // Get user language
    const userResult = await this.db.query<{ language: string }>(
      `SELECT language FROM users WHERE id = $1`,
      [userId]
    );
    const userLanguage = userResult.rows[0]?.language;

    // Get recent messages for context
    const recentMessages = await this.getRecentMessages(userId, 20);

    // Add the new exchange
    const allMessages = [
      ...recentMessages,
      { role: 'user' as const, content: userMessage },
      { role: 'assistant' as const, content: assistantResponse },
    ];

    try {
      // Step 1: Detect which concern this conversation is about
      const concernTitle = await aiService.detectConcernTitle(allMessages, userLanguage);

      // Step 2: Get or create the concern
      const concern = await concernService.getOrCreateConcern(userId, concernTitle);

      // Step 3: Generate updated summary for this specific concern
      const newSummary = await aiService.generateSummary(
        allMessages,
        concern.summaryContent,
        userLanguage
      );

      // Step 4: Update the concern (creates snapshot if meaningful change)
      await concernService.updateConcernSummary(concern.id, newSummary, 'auto_update');

      // Step 5: Also update the legacy memories table for backward compat
      await this.upsertLegacySummary(userId, newSummary);
    } catch (error) {
      // Fallback to legacy flow if concern tables don't exist yet
      const currentSummary = await this.getHealthSummary(userId);
      const newSummary = await aiService.generateSummary(allMessages, currentSummary, userLanguage);
      await this.upsertLegacySummary(userId, newSummary);
    }
  }

  /**
   * Upsert summary in the legacy memories table (for backward compatibility)
   */
  private async upsertLegacySummary(userId: string, summary: string): Promise<void> {
    const existing = await this.db.query(
      `SELECT id FROM memories WHERE user_id = $1 AND category = 'health_summary'`,
      [userId]
    );

    if (existing.rows.length > 0) {
      await this.db.query(
        `UPDATE memories SET content = $1, created_at = NOW(), access_count = access_count + 1
         WHERE user_id = $2 AND category = 'health_summary'`,
        [summary, userId]
      );
    } else {
      await this.db.query(
        `INSERT INTO memories (id, user_id, content, category, importance_score, created_at, access_count)
         VALUES (gen_random_uuid(), $1, $2, 'health_summary', 1.0, NOW(), 0)`,
        [userId, summary]
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

  async getTemplate(key: string, language: string = 'es'): Promise<string> {
    const template = await getConfigTemplate(key, language as 'es' | 'en');
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
    prompt += `\n\nLANGUAGE ADAPTATION (CRITICAL)
You MUST respond in the SAME language the user writes in. This is non-negotiable.

Detection rules:
- If user writes in Spanish → respond entirely in Spanish
- If user writes in English → respond entirely in English
- If user writes in Portuguese → respond entirely in Portuguese
- If user writes in French → respond entirely in French
- If user writes in ANY other language → respond in that same language

Never mix languages. Never default to Spanish unless user writes in Spanish.
The user's first message determines the language for the conversation.
${userLanguage ? `User's stored language preference: ${userLanguage}` : 'No stored preference - detect from user message.'}`;

    // Note: Summary link is added automatically by postProcess - do not instruct AI to add it

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

  private getDefaultTemplate(key: string, language: string): string {
    const templates: Record<string, Record<string, string>> = {
      no_credits: {
        es: 'CareLog necesita créditos adicionales para continuar. Visita la web para más información.',
        en: 'CareLog needs additional credits to continue. Visit the website for more info.',
        pt: 'CareLog precisa de créditos adicionais para continuar. Visite o site para mais informações.',
        fr: 'CareLog a besoin de crédits supplémentaires pour continuer. Visitez le site pour plus d\'infos.',
      },
      error: {
        es: 'Algo salió mal. Intenta de nuevo.',
        en: 'Something went wrong. Please try again.',
        pt: 'Algo deu errado. Por favor, tente novamente.',
        fr: 'Une erreur s\'est produite. Veuillez réessayer.',
      },
      maintenance: {
        es: 'CareLog no está disponible en este momento. Vuelve pronto.',
        en: 'CareLog is temporarily unavailable. Please try again soon.',
        pt: 'CareLog está temporariamente indisponível. Tente novamente em breve.',
        fr: 'CareLog est temporairement indisponible. Réessayez bientôt.',
      },
      // Step 1: First Contact - Transparent, trust-building introduction
      onboarding_greeting: {
        es: 'Hola 👋\nSoy CareLog.\nTe ayudo a convertir lo que ha pasado con tu salud en una nota clara y organizada para tu próxima consulta médica.\nNo soy un médico y no doy diagnósticos.\nTu información es tuya. Tú decides qué compartir.\n¿Qué ha estado pasando últimamente?',
        en: 'Hello 👋\nI\'m CareLog.\nI help you turn what\'s been happening with your health into a clear, organized note for your next doctor visit.\nI\'m not a doctor and I don\'t give diagnoses.\nYour information is yours. You decide what to share.\nWhat\'s been going on lately?',
        pt: 'Olá 👋\nSou CareLog.\nAjudo você a transformar o que está acontecendo com sua saúde em uma nota clara e organizada para sua próxima consulta médica.\nNão sou médico e não dou diagnósticos.\nSuas informações são suas. Você decide o que compartilhar.\nO que tem acontecido ultimamente?',
        fr: 'Bonjour 👋\nJe suis CareLog.\nJe vous aide à transformer ce qui se passe avec votre santé en une note claire et organisée pour votre prochaine consultation médicale.\nJe ne suis pas médecin et je ne donne pas de diagnostics.\nVos informations vous appartiennent. Vous décidez ce que vous partagez.\nQu\'est-ce qui s\'est passé dernièrement?',
      },
      // Step 3: Summary Delivered - Ask for name to personalize
      summary_delivered: {
        es: 'Tu nota está guardada. Puedes verla o compartirla con tu médico cuando quieras.\n\nPor cierto, ¿cómo te llamas? Así personalizo tu resumen.',
        en: 'Your note is saved. You can view it or share it with your doctor anytime.\n\nBy the way, what\'s your name? I\'ll personalize your summary.',
        pt: 'Sua nota está salva. Você pode vê-la ou compartilhá-la com seu médico quando quiser.\n\nA propósito, como você se chama? Vou personalizar seu resumo.',
        fr: 'Votre note est enregistrée. Vous pouvez la consulter ou la partager avec votre médecin.\n\nAu fait, comment vous appelez-vous? Je personnaliserai votre résumé.',
      },
      // AI disclosure no longer needed - transparency is built into the greeting
      // Step 2: Intake & Clarifying Questions (One at a time)
      intake_framing: {
        es: 'Voy a hacerte algunas preguntas simples para organizar esto claramente.',
        en: 'I\'ll ask a few simple questions so I can capture this clearly for you.',
        pt: 'Vou fazer algumas perguntas simples para organizar isso claramente.',
        fr: 'Je vais poser quelques questions simples pour bien organiser cela.',
      },
      micro_when: {
        es: '¿Cuándo comenzó esto?',
        en: 'When did this start?',
        pt: 'Quando isso começou?',
        fr: 'Quand cela a-t-il commencé?',
      },
      micro_location: {
        es: '¿Dónde exactamente lo sientes?',
        en: 'Where exactly do you feel it?',
        pt: 'Onde exatamente você sente isso?',
        fr: 'Où exactement le ressentez-vous?',
      },
      micro_pattern: {
        es: '¿Hay algo que lo mejore o empeore?',
        en: 'Is there anything that makes it better or worse?',
        pt: 'Há algo que melhore ou piore?',
        fr: 'Y a-t-il quelque chose qui améliore ou aggrave?',
      },
      micro_impact: {
        es: '¿Cómo está afectando tu día a día?',
        en: 'How is this affecting your daily life?',
        pt: 'Como isso está afetando seu dia a dia?',
        fr: 'Comment cela affecte-t-il votre quotidien?',
      },
      // Step 5: Name Request - Natural, no disclaimers
      ask_name: {
        es: 'Por cierto, ¿cómo te llamas?',
        en: 'By the way, what\'s your name?',
        pt: 'A propósito, como você se chama?',
        fr: 'Au fait, comment vous appelez-vous?',
      },
      // Post-Summary - Simplified (no numbered options)
      post_summary_prompt: {
        es: 'Tu nota está lista. ¿Quieres agregar algo más antes de verla?',
        en: 'Your note is ready. Want to add anything else before viewing it?',
        pt: 'Sua nota está pronta. Quer adicionar algo mais antes de vê-la?',
        fr: 'Votre note est prête. Voulez-vous ajouter autre chose avant de la consulter?',
      },
      // Safety: Urgent Care
      urgent_care: {
        es: `Estos síntomas pueden necesitar atención urgente. Te recomiendo que contactes a un servicio de emergencias o vayas a urgencias ahora.

Si quieres, puedo preparar un resumen de lo que me has contado para que se lo muestres al médico.`,
        en: `These symptoms may need urgent attention. I recommend you contact emergency services or go to urgent care now.

If you'd like, I can prepare a summary of what you've told me to show the clinician.`,
        pt: `Esses sintomas podem precisar de atenção urgente. Recomendo que você entre em contato com serviços de emergência ou vá ao pronto-socorro agora.

Se quiser, posso preparar um resumo do que você me contou para mostrar ao médico.`,
        fr: `Ces symptômes peuvent nécessiter une attention urgente. Je vous recommande de contacter les services d'urgence ou d'aller aux urgences maintenant.

Si vous le souhaitez, je peux préparer un résumé de ce que vous m'avez dit pour le montrer au médecin.`,
      },
      logged: {
        es: 'Registrado.',
        en: 'Logged.',
        pt: 'Registrado.',
        fr: 'Enregistré.',
      },
    };

    // Return template in requested language, fallback to English, then Spanish
    return templates[key]?.[language] || templates[key]?.en || templates[key]?.es || '';
  }

  private getDefaultSystemPrompt(): string {
    return `You are CareLog, a health documentation assistant.

═══════════════════════════════════════════════════════════════
CORE IDENTITY
═══════════════════════════════════════════════════════════════
You are CareLog — a tool that helps people organize their health concerns
into clear, useful notes for doctor visits.

Key principles:
- Be transparent from the start (you're not a doctor, you don't diagnose)
- Be conversational and warm, not clinical or robotic
- Respect user privacy — they control what they share
- Move efficiently toward a useful summary

═══════════════════════════════════════════════════════════════
ONBOARDING FLOW
═══════════════════════════════════════════════════════════════

▶ STEP 1 — First Contact
────────────────────────────────────────
If user sends a greeting ("hi", "hola", "hello", etc.):

English:
"Hello 👋
I'm CareLog.
I help you turn what's been happening with your health into a clear, organized note for your next doctor visit.
I'm not a doctor and I don't give diagnoses.
Your information is yours. You decide what to share.
What's been going on lately?"

Spanish:
"Hola 👋
Soy CareLog.
Te ayudo a convertir lo que ha pasado con tu salud en una nota clara y organizada para tu próxima consulta médica.
No soy un médico y no doy diagnósticos.
Tu información es tuya. Tú decides qué compartir.
¿Qué ha estado pasando últimamente?"

If user starts with their health concern directly (no greeting), skip the intro and acknowledge what they shared, then ask your first clarifying question.

▶ STEP 2 — Smart Intake (2-3 questions max)
────────────────────────────────────────
After user shares a concern, ask SHORT follow-up questions.

RULES:
- ONE question at a time
- Only ask what's needed for a useful summary
- Stop asking when you have: main concern + when it started + one useful detail
- Don't over-question — if user gives rich detail, move to summary faster

Priority questions (pick 1-2, not all):
• "When did this start?" / "¿Cuándo comenzó?"
• "Is there anything that makes it better or worse?" / "¿Hay algo que lo mejore o empeore?"
• "Have you tried anything for it?" / "¿Has probado algo?"

AVOID:
- Medical advice or reassurance ("this sounds normal", "you should be fine")
- Diagnosis or speculation
- Asking more than 3 questions total before generating summary

▶ STEP 3 — Generate Summary (The Value Moment)
────────────────────────────────────────────────────────
When you have enough info (concern + onset + 1 detail), generate a summary.

Use this format:

📝 *Tu nota de salud*

*Motivo:* [what's happening]
*Inicio:* [when it started]
*Mejora con:* [what helps, if mentioned]
*Empeora con:* [what worsens, if mentioned]
*Medicamentos:* [if any mentioned]

---

English version uses: *Your health note*, *Concern:*, *Started:*, *Helps:*, *Worsens:*, *Medications:*

RULES:
- Keep it SHORT (5 lines max)
- Use the user's own words when possible
- Only include fields where info was actually provided
- Skip fields where info is unknown (don't write "not provided")

▶ STEP 4 — After Summary: Ask for Name
──────────────────────────────────────────────────
After the summary, ALWAYS ask for their name in the same message:

Spanish:
"Tu nota está guardada. Puedes verla o compartirla con tu médico cuando quieras.

Por cierto, ¿cómo te llamas? Así personalizo tu resumen."

English:
"Your note is saved. You can view it or share it with your doctor anytime.

By the way, what's your name? I'll personalize your summary."

Portuguese:
"Sua nota está salva. Você pode vê-la ou compartilhá-la com seu médico quando quiser.

A propósito, como você se chama? Vou personalizar seu resumo."

French:
"Votre note est enregistrée. Vous pouvez la consulter ou la partager avec votre médecin.

Au fait, comment vous appelez-vous? Je personnaliserai votre résumé."

RULES:
- ALWAYS ask for name after delivering the summary
- Keep it natural, no disclaimers about it being optional
- If they don't answer, that's fine — move on without comment

═══════════════════════════════════════════════════════════════
CONVERSATION STYLE
═══════════════════════════════════════════════════════════════
- WhatsApp-short messages (no walls of text)
- Warm but efficient
- Use *bold* for emphasis (WhatsApp format)
- Use emojis sparingly (👋 for greeting, 📝 for summary)
- Match the user's language
- One question at a time

═══════════════════════════════════════════════════════════════
SAFETY (ALWAYS ON)
═══════════════════════════════════════════════════════════════
Watch for red flags:
- Chest pain, difficulty breathing
- Stroke symptoms (face drooping, slurred speech, sudden confusion)
- Severe allergic reactions
- Self-harm or suicidal thoughts

If detected:
- Stop normal flow immediately
- Recommend emergency care clearly and calmly
- Offer to prepare a quick note for the clinician

Example:
"Estos síntomas necesitan atención médica urgente. Por favor llama a emergencias o ve a urgencias ahora. ¿Te preparo un resumen rápido de lo que me contaste para mostrar al médico?"

═══════════════════════════════════════════════════════════════
WHAT NOT TO DO
═══════════════════════════════════════════════════════════════
- Don't diagnose or speculate about conditions
- Don't give medical advice or treatment recommendations
- Don't say "this sounds normal" or "you should be fine"
- Don't ask too many questions (3 max before summary)
- Don't add the summary link — it's added automatically
- Don't overwhelm with numbered options after summary

═══════════════════════════════════════════════════════════════
INTERNAL CHECK (Before Every Message)
═══════════════════════════════════════════════════════════════
1. Is this message short and conversational?
2. Am I asking only ONE question?
3. Am I moving toward a useful summary?
4. Am I avoiding medical advice or diagnosis?

If not → revise.`;
  }
}
