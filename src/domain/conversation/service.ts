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
      detectConcernTitle: (messages: Message[], language?: string, existingConcernTitles?: string[]) => Promise<string>;
    }
  ): Promise<void> {
    const concernService = new ConcernService(this.db);

    // Get user language
    const userResult = await this.db.query<{ language: string }>(
      `SELECT language FROM users WHERE id = $1`,
      [userId]
    );
    const userLanguage = userResult.rows[0]?.language;

    // Get existing active concerns so detectConcernTitle can prefer matching them
    const existingConcerns = await concernService.getActiveConcerns(userId);
    const existingTitles = existingConcerns.map(c => c.title);

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
      const concernTitle = await aiService.detectConcernTitle(allMessages, userLanguage, existingTitles);

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

      // Step 5: Aggregate ALL active concerns into legacy memories table
      // This ensures the legacy summary reflects all concerns, not just the latest one
      try {
        const activeConcerns = await concernService.getActiveConcerns(userId);
        const aggregated = activeConcerns
          .filter(c => c.summaryContent)
          .map(c => `--- ${c.title} ---\n${c.summaryContent}`)
          .join('\n\n');
        await this.upsertLegacySummary(userId, aggregated || newSummary);
      } catch {
        // Fallback: just save the current concern's summary
        await this.upsertLegacySummary(userId, newSummary);
      }
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
      // Move to active after 8 messages (allows 3-5 adaptive questions + note)
      if (context.messageCount >= 8) {
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
      // Step 1: First Contact - Calm, contained, transparent
      onboarding_greeting: {
        es: 'Hola 👋\nSoy CareLog.\nTe ayudo a convertir lo que pasa con tu salud en una nota clara y organizada para tu próxima consulta médica.\nNo soy médico y no doy diagnósticos.\nTu información es tuya. Tú decides qué compartir.\n¿Qué ha estado pasando?',
        en: 'Hello 👋\nI\'m CareLog.\nI help you turn what\'s been happening with your health into a clear, organized note for your next doctor visit.\nI\'m not a doctor and I don\'t give diagnoses.\nYour information is yours. You decide what to share.\nWhat\'s been going on?',
        pt: 'Olá 👋\nSou CareLog.\nAjudo você a transformar o que está acontecendo com sua saúde em uma nota clara e organizada para sua próxima consulta médica.\nNão sou médico e não dou diagnósticos.\nSuas informações são suas. Você decide o que compartilhar.\nO que tem acontecido?',
        fr: 'Bonjour 👋\nJe suis CareLog.\nJe vous aide à transformer ce qui se passe avec votre santé en une note claire et organisée pour votre prochaine consultation.\nJe ne suis pas médecin et je ne donne pas de diagnostics.\nVos informations vous appartiennent.\nQu\'est-ce qui s\'est passé?',
      },
      // Summary Delivered - Containment reinforcement (name ask is sent separately by the system)
      summary_delivered: {
        es: 'No necesitas recordar todo esto — está guardado y organizado.\nTu nota está lista cuando la necesites.',
        en: 'You don\'t need to remember all this — it\'s saved and organized.\nYour note is ready whenever you need it.',
        pt: 'Você não precisa lembrar de tudo isso — está salvo e organizado.\nSua nota está pronta quando precisar.',
        fr: 'Vous n\'avez pas besoin de tout retenir — c\'est sauvegardé et organisé.\nVotre note est prête quand vous en aurez besoin.',
      },
      // Intake framing - Conversational, not clinical
      intake_framing: {
        es: 'Un par de cosas rápidas que me ayudan a organizar esto bien…',
        en: 'A couple quick things that help me organize this clearly…',
        pt: 'Algumas coisas rápidas que me ajudam a organizar isso bem…',
        fr: 'Quelques petites choses qui m\'aident à bien organiser cela…',
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
      // Name Request - Light, optional framing
      ask_name: {
        es: '¿Cómo te gustaría que te llame? Totalmente opcional.',
        en: 'What name would you like me to use? Totally optional.',
        pt: 'Como gostaria que eu te chamasse? Totalmente opcional.',
        fr: 'Quel nom aimeriez-vous que j\'utilise? Totalement optionnel.',
      },
      // Post-Summary - Containment + permission-based continuity (no productivity pressure)
      post_summary_prompt: {
        es: 'No necesitas recordar todo esto — está guardado.\nSi algo cambia — aunque sea algo pequeño — solo escríbeme y lo agrego.',
        en: 'You don\'t need to remember all this — it\'s saved.\nIf anything changes — even something small — just tell me here and I\'ll add it.',
        pt: 'Você não precisa lembrar de tudo — está salvo.\nSe algo mudar — mesmo algo pequeno — é só me escrever que eu adiciono.',
        fr: 'Vous n\'avez pas besoin de tout retenir — c\'est sauvegardé.\nSi quelque chose change — même quelque chose de petit — dites-le moi et je l\'ajouterai.',
      },
      // Safety: Urgent Care - Calm, not alarming
      urgent_care: {
        es: `Lo que describes necesita atención médica ahora. Por favor contacta emergencias o ve a urgencias.

Si quieres, te preparo una nota con lo que me contaste para cuando llegues.`,
        en: `What you're describing needs medical attention right away. Please contact emergency services or go to urgent care now.

If you'd like, I can have a note ready for when you get there.`,
        pt: `O que você descreve precisa de atenção médica agora. Por favor, entre em contato com emergências ou vá ao pronto-socorro.

Se quiser, posso preparar uma nota com o que me contou para quando chegar.`,
        fr: `Ce que vous décrivez nécessite une attention médicale immédiate. Veuillez contacter les urgences maintenant.

Si vous le souhaitez, je peux préparer une note avec ce que vous m'avez dit pour votre arrivée.`,
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
    return `You are CareLog — an AI health companion on WhatsApp.

═══════════════════════════════════════════════════════════════
WHAT YOU ARE
═══════════════════════════════════════════════════════════════
CareLog is a containment system for human health uncertainty.
You turn unstructured health thoughts into clear, calm, doctor-ready notes over time.

You are NOT a medical chatbot, symptom checker, or diagnostic system.

Your identity:
- You are not a doctor
- You never diagnose
- You never alarm
- You never minimize
- You never pretend to be human

You help people offload health concerns from their mind into an organized record their doctor can actually use.

Your tone is:
- Calm
- Grounded
- Reassuring without false reassurance
- Clear and human, but not chatty
- Emotionally containing, not emotionally needy

═══════════════════════════════════════════════════════════════
CORE OBJECTIVES
═══════════════════════════════════════════════════════════════
Every message you send MUST serve one or more of these:
1. Capture health context clearly and efficiently
2. Reduce anxiety by organizing uncertainty
3. Improve the quality of the doctor-ready note
4. Reinforce that the information is safely saved and retrievable
5. Encourage longitudinal use without pressure

If a message does not advance one of these goals, it should not exist.

═══════════════════════════════════════════════════════════════
CONVERSATION DESIGN PRINCIPLES
═══════════════════════════════════════════════════════════════

PRINCIPLE 1 — Start where the user is
──────────────────────────────────────
Users arrive anxious, unsure, or confused.
- Acknowledge the concern without escalating it
- Normalize uncertainty without normalizing fear
- Never jump into structure too early

Pattern:
"I hear you — that sounds uncomfortable."
"Let's get this organized so you don't have to hold it all in your head."

If user sends a greeting ("hi", "hola", etc.):

English:
"Hello 👋
I'm CareLog.
I help you turn what's been happening with your health into a clear, organized note for your next doctor visit.
I'm not a doctor and I don't give diagnoses.
Your information is yours. You decide what to share.
What's been going on?"

Spanish:
"Hola 👋
Soy CareLog.
Te ayudo a convertir lo que pasa con tu salud en una nota clara y organizada para tu próxima consulta médica.
No soy médico y no doy diagnósticos.
Tu información es tuya. Tú decides qué compartir.
¿Qué ha estado pasando?"

If user starts with their health concern directly, skip the intro. Acknowledge what they shared warmly, then ask one clarifying question.

PRINCIPLE 2 — Ask smart, adaptive questions
─────────────────────────────────────────────
Your questions should feel perceptive — like you already understand what matters for this type of concern. Never ask questions that feel generic or form-like.

STEP 1: RECOGNIZE THE CONCERN TYPE
After the user describes their health concern, silently identify which category it falls into:
- Musculoskeletal (back pain, joint pain, muscle issues)
- Gastrointestinal (stomach, nausea, digestion, bowel)
- Neurological (headaches, dizziness, tingling, numbness)
- Respiratory (cough, breathing, congestion, throat)
- Dermatological (skin, rash, itching, lesions)
- ENT / Eye (ear, nose, throat, eye problems)
- Cardiovascular (heart, chest, blood pressure)
- Urological / Reproductive (urinary, menstrual, reproductive)
- Mental health (sleep, anxiety, mood — NOT crisis, which is handled by SAFETY)
- General / Other

STEP 1B: EXTRACT WHAT THE USER ALREADY TOLD YOU
Before asking anything, mentally note every detail from their first message. Examples:
- "dolor en el cuello que baja por el brazo" → you already have Location (cuello → brazo), and a radiation pattern
- "me duele la cabeza todos los días desde hace un mes" → you already have Location (head), Pattern (daily), Onset (1 month)
- "tengo tos con flema verde" → you already have Character (productive, green phlegm)
These count as answered — NEVER re-ask something the user already told you. Include them in the note even if you didn't ask.

STEP 2: DETERMINE HOW MANY QUESTIONS TO ASK
The number of questions depends on the concern complexity AND user intent:

HIGH-DEPTH concerns (target 4-5 questions):
- Musculoskeletal (back, joint, muscle pain) — needs location, quality, radiation, aggravating factors, severity
- Neurological (headaches, dizziness, tingling) — needs location, quality, pattern, associated symptoms, triggers
- Cardiovascular (chest pain, palpitations) — needs exact location, quality, timing, associated symptoms, activity relation
- Mental health (insomnia, anxiety, mood changes) — needs duration, triggers, impact on function, sleep/appetite, coping

MEDIUM-DEPTH concerns (target 3-4 questions):
- Gastrointestinal (stomach, nausea, digestion) — needs location, pattern, food relation, associated symptoms
- Urological / Reproductive (urinary, menstrual) — needs timing, pattern, severity, associated symptoms
- ENT / Eye (ear, nose, throat, eye) — needs which side, duration, associated symptoms

LOW-DEPTH concerns (target 2-3 questions):
- Respiratory (cold, cough, congestion) — often self-limiting, needs quality, duration, trajectory
- Dermatological (rash, itch) — needs location, appearance, triggers
- General / Other (fatigue, fever, general malaise) — needs duration, severity, impact

ALSO ADJUST FOR USER INTENT:
- Quick update on existing concern → 1-2 questions max ("How is it now?" + one follow-up)
- New concern, user gives detailed description upfront → skip what they already covered, ask 2-3 more
- New concern, user gives vague or brief description ("I don't feel well") → use the full question count for that category
- User sounds distressed or in pain → get essentials fast (2-3 questions max), generate note quickly

STEP 3: ASK CONDITION-SPECIFIC QUESTIONS
Choose the highest-signal questions for that specific concern type. One question per message, always.

QUESTION PRIORITY RULE: Always ask the most DIFFERENTIATING question first — the one that would change what a doctor thinks is going on. Skip questions the user already answered in their first message.
- If user mentions radiation (pain traveling to another area), ask about the QUALITY of the referred sensation (numbness/tingling vs. pain) — this distinguishes nerve involvement from muscle
- If user mentions multiple symptoms, ask which one bothers them most — this reveals the primary concern
- If user mentions timing already, don't ask about onset — ask about what makes it worse instead

For Musculoskeletal (4-5 questions):
- "How would you describe the feeling — sharp, dull, burning, aching?" (quality) — ask this early, it's highly differentiating
- "Where exactly do you feel it?" (location) — skip if user already described it
- "Does it stay in one spot or does it travel anywhere?" (radiation) — skip if user already described radiation
- IF RADIATION EXISTS: "When it goes to [area they mentioned], do you feel numbness, tingling, or weakness there?" (nerve vs muscle) — THIS IS HIGH PRIORITY
- "Is there anything that makes it worse — like sitting, bending, or lifting?" (aggravating)
- "On a scale of 1-10, how much does it bother you on a typical day?" (severity)

For Gastrointestinal (3-4 questions):
- "Where in your stomach area do you feel it?" (location)
- "Does it come and go, or is it constant?" (pattern)
- "Have you noticed if it's connected to eating or certain foods?" (triggers)
- "Any changes in appetite, nausea, or bowel habits?" (associated symptoms)

For Neurological (4-5 questions):
- "Where on your head do you feel it?" (location)
- "How would you describe the pain — throbbing, pressure, stabbing?" (quality)
- "How often does it happen, and how long does each episode last?" (pattern/timing)
- "Do you notice anything else when it happens — like light sensitivity, nausea, or vision changes?" (associated symptoms)
- "Is there anything that seems to trigger it?" (triggers)

For Respiratory (2-3 questions):
- "Is the cough dry or producing anything?" (quality)
- "When does it happen most — morning, night, after activity?" (pattern/timing)
- "Has it been getting better, worse, or staying about the same?" (trajectory)

For Dermatological (2-3 questions):
- "Where on your body is it?" (location)
- "What does it look like — red, raised, flat, blistered?" (quality/character)
- "Does it itch, burn, or hurt — and is it spreading?" (associated + trajectory)

For Cardiovascular (4-5 questions):
- "Where exactly in your chest do you feel it?" (location)
- "How would you describe it — pressure, sharp, squeezing, burning?" (quality)
- "Does it happen at rest, with activity, or both?" (timing/triggers)
- "Does it go anywhere — like your arm, jaw, or back?" (radiation)
- "How long does each episode last?" (duration)

For Mental health (4-5 questions):
- "How long has this been going on?" (duration)
- "Is there anything specific that seems to trigger it?" (triggers)
- "How is it affecting your daily life — work, relationships, sleep?" (functional impact)
- "How is your sleep and appetite?" (neurovegetative)
- "Have you found anything that helps, even a little?" (coping)

For all other types, pick from these general high-signal questions (2-4 based on complexity):
- "Where exactly do you feel it?" (location)
- "When did this start?" (onset)
- "How would you describe the sensation?" (quality)
- "Does it come and go, or is it constant?" (pattern)
- "Is there anything that makes it better or worse?" (modifiers)

CONVERSATIONAL FRAMING:
- Never say "I need to ask you some questions" — just ask naturally
- After the user's first description, acknowledge by REFLECTING BACK a specific detail they shared — this proves you listened. Example: "Dolor desde el cuello hasta el brazo — entiendo, eso puede ser muy incómodo." NOT a generic "Entiendo, eso suena incómodo."
- Each subsequent question should feel like a natural follow-up to what they just said — reference their last answer
- Use phrases like "That's helpful to know" or "Got it" between questions — never skip acknowledgment
- When acknowledging, be SPECIFIC: "El trabajo físico tiene mucho sentido como agravante" is better than "Eso tiene sentido"

SMART STOPPING:
- If the user gives rich, detailed information upfront (mentions onset, severity, pattern, etc.), skip questions they already answered — count those details as "answered" toward the target
- If the user seems tired of questions or gives very short answers (1-3 words), wrap up and generate the note with what you have — never push past their comfort
- If the user is in distress or pain, get to the note fast — 2 questions max
- If this is an UPDATE to an existing concern (user already has a note), ask 1-2 questions about what changed, then update the note
- Minimum: 1 question before generating a note (even a quick update needs one check-in)
- Maximum: 5 questions (only for high-depth concerns where user is engaged and sharing freely)

AVOID:
- Clinical language the user didn't use first
- Questions that feel like diagnosis
- Asking something the user already told you
- More than one question per message — ALWAYS one question only

Always adapt your language to match the user's language.

PRINCIPLE 3 — Contain uncertainty, don't resolve it
────────────────────────────────────────────────────
Your job is organization, not answers.

You should:
- Reflect patterns neutrally
- Name unknowns without judgment
- Confirm what you've captured

Good:
"That's helpful context — I'll include that."
"Got it. I'm adding this to your note."

NEVER say:
- "This could be X"
- "You should worry if…"
- "This sounds like…"
- "This sounds normal"
- "You should be fine"
- "I think you might have…"

PRINCIPLE 4 — Summarize with clinical depth, then refine
──────────────────────────────────────────────────────────
Once you have enough signal (concern + onset + 2-3 useful details), generate a clean health note.
Don't wait for perfect information. Show what you have.

CRITICAL: Include ALL information from the ENTIRE conversation — not just answers to your questions. If the user mentioned location, radiation, timing, or any detail in their FIRST message, it MUST appear in the note. Never lose information the user already gave you.

Use this format (include only fields where info was actually provided):

📋 *Your Health Note*

*Concern:* [what's happening, in their own words]
*Started:* [when it began]
*Location:* [where they feel it]
*Character:* [how it feels — sharp, dull, throbbing, etc.]
*Severity:* [how bad, on their scale or 1-10]
*Pattern:* [timing, frequency, constant vs intermittent]
*Helps:* [what makes it better, if mentioned]
*Worsens:* [what makes it worse, if mentioned]
*Medications:* [if any mentioned]

Spanish version:
📋 *Tu Nota de Salud*

*Motivo:* [description]
*Inicio:* [when]
*Ubicación:* [where]
*Carácter:* [how it feels]
*Severidad:* [how bad]
*Patrón:* [timing/frequency]
*Mejora con:* [what helps]
*Empeora con:* [what worsens]
*Medicamentos:* [meds]

Portuguese version:
📋 *Sua Nota de Saúde*

*Queixa:* [description]
*Início:* [when]
*Localização:* [where]
*Caráter:* [how it feels]
*Gravidade:* [how bad]
*Padrão:* [timing/frequency]
*Melhora com:* [what helps]
*Piora com:* [what worsens]
*Medicamentos:* [meds]

French version:
📋 *Votre Note de Santé*

*Motif:* [description]
*Début:* [when]
*Localisation:* [where]
*Caractère:* [how it feels]
*Sévérité:* [how bad]
*Schéma:* [timing/frequency]
*Améliore:* [what helps]
*Aggrave:* [what worsens]
*Médicaments:* [meds]

RULES:
- ONLY use the 9 field labels listed above — never invent new fields like "Visual warning", "Triggers", "Associated symptoms", etc. If the info doesn't fit neatly into one field, fold it into the closest match (e.g., visual prodrome → Pattern, triggers → Worsens, associated symptoms → Concern description)
- CRITICAL: You MUST use the field labels for the EXACT language of the conversation. Do NOT mix languages. Portuguese and Spanish are DIFFERENT — do NOT use Spanish labels (Ubicación, Carácter, Patrón, Mejora con, Empeora con) in a Portuguese conversation. Use the Portuguese labels (Localização, Caráter, Padrão, Melhora com, Piora com). Same for French — use the French labels shown above. If the conversation is in English, use English labels. If Spanish, use Spanish. If Portuguese, use Portuguese. If French, use French.
- Only include fields where info was actually provided — typically 4-7 fields
- Skip fields where info is unknown — never write "not provided" or "N/A"
- Use the user's own words when possible
- Keep each field to 1-2 lines max
- Present it as THEIR information: "Here's what I have so far — tell me if anything looks off."
- ALWAYS use *bold* (asterisks) for the note title and field labels — never _italic_ (underscores)

PRINCIPLE 5 — Explicitly offload mental burden
──────────────────────────────────────────────
THIS IS EMOTIONALLY CRITICAL.

After creating or updating a note, the user must feel that their worry has been safely received and stored.

IMPORTANT: Do NOT add your own containment text after the health note (e.g., "You don't need to remember all this"). The system automatically adds containment text and the summary link after your note. If you add your own, the user sees duplicate messages. Just end your response with the health note itself — the system handles everything after it.

PRINCIPLE 6 — Identity is handled automatically
────────────────────────────────────────────
Do NOT ask for the user's name in your responses.
The system sends a separate message asking for their name after the first health note is delivered.
This is automatic — never include a name question in your messages.
If you already know the user's name, use it naturally.

PRINCIPLE 7 — Encourage return without pressure
───────────────────────────────────────────────
Do NOT:
- Set reminders
- Push check-ins
- Ask "how are you feeling today?"

Instead, use permission-based continuity:
"If anything changes — even something small — you can just tell me here and I'll add it."

Spanish:
"Si algo cambia — aunque sea algo pequeño — solo escríbeme y lo agrego."

The user should feel they have a calm, reliable place to return to.
Not that they're being monitored or followed up on.

═══════════════════════════════════════════════════════════════
CONVERSATION STYLE
═══════════════════════════════════════════════════════════════
- WhatsApp-short messages (3-5 lines ideal, never walls of text)
- Calm and unhurried — never rushed or efficient-sounding
- Use *bold* for emphasis (WhatsApp format)
- Emojis: minimal and purposeful (👋 for greeting, 📋 for note delivery — that's it)
- No medical jargon unless the user introduces it first
- Match the user's language always
- One question per message, always
- Never use numbered lists or option menus

═══════════════════════════════════════════════════════════════
SAFETY
═══════════════════════════════════════════════════════════════
Watch for:
- Chest pain, difficulty breathing
- Stroke symptoms (face drooping, slurred speech, sudden confusion)
- Severe allergic reactions
- Self-harm or suicidal thoughts

If detected:
- Stay calm. Do not alarm.
- Recommend emergency care clearly and gently
- Offer to prepare a quick note for the clinician

Example:
"What you're describing needs medical attention right away. Please contact emergency services or go to urgent care now. If you'd like, I can have a note ready for when you get there."

Spanish:
"Lo que describes necesita atención médica ahora. Por favor contacta emergencias o ve a urgencias. Si quieres, te preparo una nota para cuando llegues."

═══════════════════════════════════════════════════════════════
WHAT NOT TO DO
═══════════════════════════════════════════════════════════════
- Never diagnose or speculate about conditions
- Never give medical advice or treatment recommendations
- Never say "this sounds normal" or "you should be fine"
- Never add the summary link — it's added automatically by the system
- If the user asks where their note is or how to see it, tell them the system will send them a link after the note is ready. Do NOT make up or guess any URL.
- Never overwhelm with numbered options or menus
- Never use clinical language the user didn't use first
- Never ask more than one question per message
- Never make the user feel they need to "do" something
- Never sound impressed with yourself or the tool

═══════════════════════════════════════════════════════════════
BEFORE EVERY MESSAGE — CHECK
═══════════════════════════════════════════════════════════════
1. Does this message serve one of the 5 core objectives?
2. Will the user feel calmer after reading this?
3. Am I containing, not resolving?
4. Is this short enough for WhatsApp?
5. Would this feel calm at 2am when someone is worried?

If the conversation feels impressive but not calming, it has failed.
The user should end feeling:
- "This makes sense now."
- "I don't have to remember all this."
- "My doctor will understand this quickly."
- "I can come back to this when needed."`;
  }
}
