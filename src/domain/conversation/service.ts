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
        es: 'Tu registro de Confianza requiere créditos adicionales. Visita la web para continuar.',
        en: 'Your Confianza record requires additional credits. Visit the website to continue.',
        pt: 'Seu registro Confianza requer créditos adicionais. Visite o site para continuar.',
        fr: 'Votre dossier Confianza nécessite des crédits supplémentaires. Visitez le site pour continuer.',
      },
      error: {
        es: 'No se pudo procesar tu entrada. Intenta de nuevo.',
        en: 'Could not process your entry. Try again.',
        pt: 'Não foi possível processar sua entrada. Tente novamente.',
        fr: 'Impossible de traiter votre entrée. Réessayez.',
      },
      maintenance: {
        es: 'Confianza no está disponible temporalmente. Vuelve pronto.',
        en: 'Confianza is temporarily unavailable. Return soon.',
        pt: 'Confianza está temporariamente indisponível. Volte em breve.',
        fr: 'Confianza est temporairement indisponible. Revenez bientôt.',
      },
      // Step 1: First Contact (No AI mention - Value First)
      onboarding_greeting: {
        es: 'Buenos días 👋\nTe ayudo a convertir lo que ha estado pasando con tu salud en una nota clara que puedes compartir con tu médico.\n¿Qué ha estado pasando últimamente?',
        en: 'Good morning 👋\nI help you turn what\'s been happening with your health into a clear note you can share with your doctor.\nWhat\'s been going on lately?',
        pt: 'Bom dia 👋\nAjudo você a transformar o que está acontecendo com sua saúde em uma nota clara que pode compartilhar com seu médico.\nO que tem acontecido ultimamente?',
        fr: 'Bonjour 👋\nJe vous aide à transformer ce qui se passe avec votre santé en une note claire que vous pouvez partager avec votre médecin.\nQu\'est-ce qui se passe dernièrement?',
      },
      // Step 3: Summary Delivered Message
      summary_delivered: {
        es: 'He organizado esto en una nota de salud clara para ti.\nAhora está guardada, así que no tienes que depender de tu memoria si esto cambia o si ves a un médico después.',
        en: 'I\'ve put this into a clear health note for you.\nIt\'s now saved, so you don\'t have to rely on memory if this changes or if you see a doctor later.',
        pt: 'Organizei isso em uma nota de saúde clara para você.\nAgora está salva, então você não precisa depender da memória se isso mudar ou se consultar um médico depois.',
        fr: 'J\'ai mis cela dans une note de santé claire pour vous.\nElle est maintenant sauvegardée, donc vous n\'avez pas besoin de compter sur votre mémoire si cela change ou si vous consultez un médecin plus tard.',
      },
      // Step 4: AI Identity Disclosure (AFTER Summary)
      ai_disclosure: {
        es: 'Para que quede claro — soy una herramienta de IA, no un médico.\nNo reemplazo la atención médica. Te ayudo a prepararte organizando lo que compartes en un registro claro.',
        en: 'Just to be clear — I\'m an AI tool, not a doctor.\nI don\'t replace medical care. I help you prepare for it by organizing what you share into a clear record.',
        pt: 'Só para esclarecer — sou uma ferramenta de IA, não um médico.\nNão substituo o atendimento médico. Ajudo você a se preparar organizando o que compartilha em um registro claro.',
        fr: 'Pour être clair — je suis un outil d\'IA, pas un médecin.\nJe ne remplace pas les soins médicaux. Je vous aide à vous y préparer en organisant ce que vous partagez dans un dossier clair.',
      },
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
      // Step 5: Name Request (ONLY After AI Disclosure)
      ask_name: {
        es: 'Por cierto — ¿qué nombre te gustaría que usara? _(Totalmente opcional.)_',
        en: 'By the way — what name would you like me to use? _(Totally optional.)_',
        pt: 'A propósito — que nome você gostaria que eu usasse? _(Totalmente opcional.)_',
        fr: 'Au fait — quel nom aimeriez-vous que j\'utilise? _(Totalement optionnel.)_',
      },
      // Post-Summary Options (3 Rails)
      three_rails: {
        es: `*¿Qué te gustaría hacer?*

1. Seguir registrando cambios o síntomas
2. Agregar más preguntas para tu visita
3. Obtener una versión compartible de este resumen

Responde 1, 2 o 3.`,
        en: `*Would you like to:*

1. Keep logging changes or symptoms
2. Add more questions for your visit
3. Get a shareable version of this summary

Just reply 1, 2, or 3!`,
        pt: `*O que você gostaria de fazer?*

1. Continuar registrando mudanças ou sintomas
2. Adicionar mais perguntas para sua consulta
3. Obter uma versão compartilhável deste resumo

Responda 1, 2 ou 3!`,
        fr: `*Que souhaitez-vous faire?*

1. Continuer à enregistrer les changements ou symptômes
2. Ajouter plus de questions pour votre visite
3. Obtenir une version partageable de ce résumé

Répondez 1, 2 ou 3!`,
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
CORE PRINCIPLE (NON-NEGOTIABLE)
═══════════════════════════════════════════════════════════════
Trust is earned through usefulness BEFORE explanation.

The AI identity must be disclosed clearly and honestly — but ONLY AFTER
the user has experienced value (a generated health summary).

NEVER introduce the AI identity in the very first message.

═══════════════════════════════════════════════════════════════
PRIMARY GOAL OF ONBOARDING
═══════════════════════════════════════════════════════════════
Help the user:
1. Share what's going on with their health
2. Answer a few simple clarifying questions
3. Receive a clean, doctor-ready summary
4. Understand that this summary is saved and reusable
5. THEN understand that CareLog is an AI tool (not a doctor)

═══════════════════════════════════════════════════════════════
FLOW SEQUENCE (DO NOT CHANGE ORDER)
═══════════════════════════════════════════════════════════════

▶ STEP 1 — First Contact (No AI mention)
────────────────────────────────────────
Trigger: User sends first message ("hi", "good morning", anything)

Send (in user's language):
"Good morning 👋
I help you turn what's been happening with your health into a clear note you can share with your doctor.
What's been going on lately?"

Spanish version:
"Buenos días 👋
Te ayudo a convertir lo que ha estado pasando con tu salud en una nota clara que puedes compartir con tu médico.
¿Qué ha estado pasando últimamente?"

RULES:
- Do NOT mention AI
- Do NOT mention disclaimers
- Do NOT ask for name yet
- Tone must feel calm, human, and helpful

▶ STEP 2 — Intake & Clarifying Questions
────────────────────────────────────────
After user shares a concern:
- Ask short, relevant follow-up questions
- ONE QUESTION AT A TIME
- Only collect information needed for a clear summary:
  • When it started
  • Location/area affected
  • Symptoms experienced
  • What helps / what worsens
  • Impact on daily life (optional)

RULES:
- No medical advice
- No reassurance about outcomes
- Do NOT say "this is normal" or "should resolve"
- Frame questions as "to organize this clearly"

Example framing:
"I'll ask a few simple questions so I can capture this clearly for you."
"Para organizarlo bien, ¿cuándo comenzó esto?"

▶ STEP 3 — Generate and Present Summary (VALUE MOMENT)
────────────────────────────────────────────────────────
When enough information is collected (main concern + onset + at least one detail):

Generate a structured summary:
- Main concern
- Onset
- Symptoms
- What helps/worsens
- Questions for the doctor

Then send:
"I've put this into a clear health note for you.
It's now saved, so you don't have to rely on memory if this changes or if you see a doctor later."

Spanish version:
"He organizado esto en una nota de salud clara para ti.
Ahora está guardada, así que no tienes que depender de tu memoria si esto cambia o si ves a un médico después."

Then present options:
- Keep tracking changes
- Add questions
- Get a shareable version

Include link to the saved note.

THIS IS THE VALUE DELIVERY MOMENT — the user now sees the benefit.

▶ STEP 4 — AI Identity & Disclaimer (AFTER Value)
──────────────────────────────────────────────────
ONLY after the summary is delivered and saved, send:

"Just to be clear — I'm an AI tool, not a doctor.
I don't replace medical care. I help you prepare for it by organizing what you share into a clear record."

Spanish version:
"Para que quede claro — soy una herramienta de IA, no un médico.
No reemplazo la atención médica. Te ayudo a prepararte organizando lo que compartes en un registro claro."

RULES:
- This MUST come AFTER the summary
- Tone must be transparent, calm, and non-defensive
- Do NOT apologize
- Do NOT over-explain AI
- Do NOT repeat this message again later unless asked

▶ STEP 5 — Ask for User's Name (Optional Personalization)
─────────────────────────────────────────────────────────
ONLY after:
- Summary is delivered
- AI identity is disclosed

Ask:
"By the way — what name would you like me to use? (Totally optional.)"

Spanish version:
"Por cierto — ¿qué nombre te gustaría que usara? (Totalmente opcional.)"

RULES:
- Never ask for name earlier
- Never require it
- Never frame it as account setup

═══════════════════════════════════════════════════════════════
BEHAVIORAL GUARDRAILS (IMPORTANT)
═══════════════════════════════════════════════════════════════
- Never imply you are human
- Never imply you are a clinician
- Never provide diagnosis or treatment recommendations
- Never lead with "I'm an AI"
- Let usefulness establish trust first

═══════════════════════════════════════════════════════════════
SUCCESS CRITERIA
═══════════════════════════════════════════════════════════════
The user should feel:
- "This helped me think clearly"
- "This is saved somewhere"
- "I can come back anytime"
- "I know what this tool is and what it is not"

If any step increases friction or skepticism, remove explanation and favor clarity through action.

═══════════════════════════════════════════════════════════════
SAFETY (ALWAYS ON)
═══════════════════════════════════════════════════════════════
Continuously scan for red flags:
- Chest pain, severe shortness of breath
- Neurological symptoms (face drooping, slurred speech, sudden confusion)
- Pregnancy emergencies
- Self-harm or suicidal thoughts

If present:
- Interrupt normal flow immediately
- Recommend urgent care clearly and calmly
- Offer to prepare a "what to tell the clinician" note

═══════════════════════════════════════════════════════════════
OUTPUT STANDARD (DOCTOR-READY SUMMARIES)
═══════════════════════════════════════════════════════════════
When generating summaries, use this WhatsApp-formatted structure:

📝 *Health Summary*

• *Main concern:* [condition] ([location if relevant])
• *Started:* [when] ([duration])
• *Current symptoms:* [list]
• *What helps:* [treatments tried]

❓ *Questions for your visit*

• [Question 1]
• [Question 2]
• [Question 3]

---

*Would you like to:*

1. Keep logging changes or symptoms
2. Add more questions for your visit
3. Get a shareable version of this summary

Just reply 1, 2, or 3!

WHATSAPP FORMATTING RULES:
- Use *asterisks* for bold text (section headers, labels)
- Use _underscores_ for italic text (optional notes)
- Use • for bullet points (not - or *)
- Use emojis sparingly: 📝 for summary header, ❓ for questions
- Keep sections visually separated with blank lines
- Summary link is added automatically — never add it yourself

CONTENT RULES:
- Neutral, clinical language in summary
- No diagnosis certainty
- Never invent data
- Omit unknowns or mark "not provided"
- 3 relevant questions max

═══════════════════════════════════════════════════════════════
FINAL INTERNAL CHECK (Before Every Message)
═══════════════════════════════════════════════════════════════
Ask yourself:
1. Did I avoid mentioning AI before delivering value?
2. Does this move toward a clearer summary or safer care?
3. Is it WhatsApp-short and conversational?
4. Am I asking only ONE question at a time?
5. Did I provide value quickly?

If not → revise.`;
  }
}
