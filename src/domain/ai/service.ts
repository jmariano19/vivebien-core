import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import { AIResponse, Message, ConversationContext, TokenUsage } from '../../shared/types';
import { AIServiceError } from '../../shared/errors';
import { logAIUsage, logger } from '../../infra/logging/logger';
import { ConversationService } from '../conversation/service';
import { db } from '../../infra/db/client';
import { RateLimiter } from '../../shared/rate-limiter';

const conversationService = new ConversationService(db);

export class AIService {
  private client: Anthropic;
  private rateLimiter: RateLimiter;

  constructor() {
    this.client = new Anthropic({
      apiKey: config.anthropicApiKey,
    });

    this.rateLimiter = new RateLimiter({
      maxRequestsPerMinute: config.claudeRpmLimit,
    });
  }

  async generateResponse(
    messages: Message[],
    context: ConversationContext,
    userId: string,
    correlationId: string
  ): Promise<AIResponse> {
    // Wait for rate limit slot
    await this.rateLimiter.acquire();

    const startTime = Date.now();

    try {
      // Get system prompt based on context (with language adaptation)
      const systemPrompt = await conversationService.getSystemPrompt(context, context.language);

      // Convert messages to Anthropic format
      const anthropicMessages = messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

      // Call Claude Opus 4.5 - best conversational model for nuanced health conversations
      const response = await this.client.messages.create({
        model: 'claude-opus-4-5-20251101',
        max_tokens: 1024,
        system: systemPrompt,
        messages: anthropicMessages,
      });

      const latencyMs = Date.now() - startTime;

      // Extract response content
      const content = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('\n');

      const usage: TokenUsage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };

      // Log usage for billing
      await logAIUsage({
        userId,
        correlationId,
        model: response.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs,
      });

      return {
        content,
        usage,
        model: response.model,
        latencyMs,
      };
    } catch (error) {
      const err = error as Error;

      // Handle rate limiting
      if (err.message.includes('429') || err.message.includes('rate_limit')) {
        throw new AIServiceError('Rate limit exceeded, please try again later', err);
      }

      // Handle other API errors
      throw new AIServiceError(err.message, err);
    }
  }

  /**
   * Post-process AI response to clean up formatting
   * Basic cleaning only — containment + link are added by the handler
   */
  postProcess(content: string): string {
    let cleaned = content;

    // Convert markdown double asterisks to WhatsApp single asterisks for bold
    cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, '*$1*');

    // Keep single *text* (WhatsApp bold) and _text_ (WhatsApp italic) as-is

    // Remove code blocks
    cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
    cleaned = cleaned.replace(/`(.+?)`/g, '$1');

    // Remove markdown headers (keep the text)
    cleaned = cleaned.replace(/^#+\s+/gm, '');

    // Remove excessive newlines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // Trim whitespace
    cleaned = cleaned.trim();

    // Limit response length (WhatsApp has a 4096 character limit)
    if (cleaned.length > 4000) {
      cleaned = cleaned.substring(0, 3997) + '...';
    }
    return cleaned;
  }

  /**
   * Split a summary response into acknowledgment + health note parts.
   * Returns null if response doesn't contain a splittable summary.
   */
  splitSummaryResponse(content: string): { acknowledgment: string; summary: string } | null {
    const noteIndex = content.indexOf('📋');
    if (noteIndex === -1) return null;

    // Look for a transition phrase before 📋 that belongs with the summary
    const beforeNote = content.substring(0, noteIndex);
    const transitionPattern = /\n+((?:here'?s|aquí|voici|aqui|esto es|this is)[^\n]*)\n*$/i;

    let splitIndex = noteIndex;
    const transitionMatch = beforeNote.match(transitionPattern);
    if (transitionMatch && transitionMatch.index !== undefined) {
      splitIndex = transitionMatch.index;
    }

    const acknowledgment = content.substring(0, splitIndex).trim();
    let summary = content.substring(splitIndex).trim();

    // Need meaningful acknowledgment text
    if (!acknowledgment || acknowledgment.length < 10) return null;

    // Strip AI-generated containment text from summary (we add our own)
    summary = this.stripContainmentText(summary);

    return { acknowledgment, summary };
  }

  /**
   * Strip AI-generated containment/continuity text to prevent duplication
   */
  private stripContainmentText(content: string): string {
    const patterns = [
      /\n+(?:no necesitas recordar|you don'?t need to remember|você não precisa lembrar|vous n'avez pas besoin de tout retenir)[^\n]*/gi,
      /\n+(?:si algo cambia|if anything changes|se algo mudar|si quelque chose change)[^\n]*/gi,
      /\n+(?:tu nota está segura|your note is safe|sua nota está segura|votre note est sûre)[^\n]*/gi,
      /\n+(?:esto está listo|this is ready|está pronto|c'est prêt)[^\n]*/gi,
      /\n+(?:no tienes que cargar|you don'?t have to carry|não precisa carregar)[^\n]*/gi,
      /\n+(?:puedes volver|come back to it|pode voltar|revenez)[^\n]*/gi,
    ];

    let cleaned = content;
    for (const pattern of patterns) {
      cleaned = cleaned.replace(pattern, '');
    }

    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Build the formatted summary message with containment + link.
   * When concernTitle is provided, prepend a header showing which concern this note belongs to.
   */
  buildSummaryMessage(summary: string, userId: string, language: string, concernTitle?: string | null): string {
    const containment = this.getContainmentText(language);
    const link = this.getSummaryLinkText(language, userId);

    let header = '';
    if (concernTitle) {
      const headerTemplates: Record<string, string> = {
        es: `📋 *Tu Nota de Salud — ${concernTitle}*`,
        en: `📋 *Your Health Note — ${concernTitle}*`,
        pt: `📋 *Sua Nota de Saúde — ${concernTitle}*`,
        fr: `📋 *Votre Note de Santé — ${concernTitle}*`,
      };
      header = (headerTemplates[language] || headerTemplates.en!) + '\n\n';
    }

    return `${header}${summary}\n\n${containment}\n\n${link}`;
  }

  /**
   * Check if the response looks like a summary
   */
  looksLikeSummary(content: string): boolean {
    const summaryIndicators = [
      // Note emoji — strongest single signal
      '📋',
      // Note title variations
      'health note', 'nota de salud', 'nota de saúde', 'note de santé',
      // Field labels (English)
      'concern:', 'started:', 'location:', 'character:', 'severity:', 'pattern:',
      'helps:', 'worsens:', 'medications:',
      // Field labels (Spanish)
      'motivo:', 'inicio:', 'ubicación:', 'carácter:', 'severidad:', 'patrón:',
      'mejora con:', 'empeora con:', 'medicamentos:',
      // Field labels (Portuguese)
      'queixa:', 'início:', 'localização:', 'caráter:', 'gravidade:', 'padrão:',
      'melhora com:', 'piora com:',
      // Field labels (French)
      'motif:', 'début:', 'localisation:', 'caractère:', 'sévérité:', 'schéma:',
      'améliore:', 'aggrave:', 'médicaments:',
      // Legacy/alternate labels
      'resumen', 'summary', 'resumo', 'résumé',
      'onset:', 'preguntas para', 'questions for', 'perguntas para', 'questions pour',
      '---', // Common separator in summaries
    ];

    const lowerContent = content.toLowerCase();
    const matchCount = summaryIndicators.filter(indicator =>
      lowerContent.includes(indicator.toLowerCase())
    ).length;

    // 📋 emoji alone is a strong signal — if present with any 1 field, it's a summary
    // Otherwise need 2+ field indicators
    return matchCount >= 2;
  }

  /**
   * Get containment reinforcement text — emotionally critical
   * Appended after every summary to offload mental burden
   * "You don't need to remember this — it's saved."
   */
  private getContainmentText(language: string): string {
    const texts: Record<string, string> = {
      es: 'No necesitas recordar todo esto — está guardado y organizado. Si algo cambia, solo escríbeme.',
      en: "You don't need to remember all this — it's saved and organized. If anything changes, just tell me.",
      pt: 'Você não precisa lembrar de tudo isso — está salvo e organizado. Se algo mudar, é só me escrever.',
      fr: "Vous n'avez pas besoin de tout retenir — c'est sauvegardé et organisé. Si quelque chose change, dites-le moi.",
    };
    return texts[language] || texts.en!;
  }

  /**
   * Get the summary link text in the appropriate language
   * Only shown after summaries, not on every message
   * Reinforces containment: the note is safely saved and accessible
   */
  private getSummaryLinkText(language: string, userId: string): string {
    const link = `https://carelog.vivebien.io/${userId}`;
    const texts: Record<string, string> = {
      es: `📋 *Tu nota está aquí* 👇\n${link}`,
      en: `📋 *Your note is here* 👇\n${link}`,
      pt: `📋 *Sua nota está aqui* 👇\n${link}`,
      fr: `📋 *Votre note est ici* 👇\n${link}`,
    };
    return texts[language] || texts.en!;
  }

  /**
   * Get the name ask message for post-summary delivery
   * Sent as a separate message after the health note to feel natural
   */
  getNameAskMessage(language: string): string {
    const messages: Record<string, string> = {
      es: 'Por cierto, ¿cómo te gustaría que te llame? Así personalizo tu Nota de Salud. Totalmente opcional.',
      en: "By the way, what's your name? I'll personalize your Health Note. Totally optional.",
      pt: 'A propósito, como gostaria que eu te chamasse? Assim personalizo sua Nota de Saúde. Totalmente opcional.',
      fr: "Au fait, quel nom aimeriez-vous que j'utilise? Je personnaliserai votre Note de Santé. Totalement optionnel.",
    };
    return messages[language] || messages.en!;
  }

  /**
   * Generate a simple response without full context (for quick replies)
   */
  async generateQuickResponse(prompt: string): Promise<string> {
    await this.rateLimiter.acquire();

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('\n');

      return this.postProcess(content);
    } catch (error) {
      const err = error as Error;
      throw new AIServiceError(err.message, err);
    }
  }

  /**
   * Generate or update a health summary based on conversation history
   * This creates a live summary that can be displayed on a website
   */
  async generateSummary(messages: Message[], currentSummary: string | null, language?: string, focusTopic?: string): Promise<string> {
    await this.rateLimiter.acquire();

    // Detect language from recent messages or use provided language
    const detectedLang = language || this.detectLanguage(messages);

    // Language-specific labels for conversation text
    const labels: Record<string, { user: string; assistant: string }> = {
      es: { user: 'Usuario', assistant: 'Asistente' },
      en: { user: 'User', assistant: 'Assistant' },
      pt: { user: 'Usuário', assistant: 'Assistente' },
      fr: { user: 'Utilisateur', assistant: 'Assistant' },
    };

    const label = labels[detectedLang] || labels.en!;
    const conversationText = messages
      .map((m) => `${m.role === 'user' ? label!.user : label!.assistant}: ${m.content}`)
      .join('\n\n');

    // Language-specific section headers (doctor-ready format)
    type HeadersType = {
      mainConcern: string;
      onset: string;
      pattern: string;
      factors: string;
      medications: string;
      questions: string;
      timeline: string;
    };
    const allHeaders: Record<string, HeadersType> = {
      es: {
        mainConcern: 'MOTIVO PRINCIPAL',
        onset: 'INICIO / DURACIÓN',
        pattern: 'PATRÓN / SEVERIDAD',
        factors: 'QUÉ AYUDA / EMPEORA',
        medications: 'MEDICAMENTOS ACTUALES',
        questions: 'PREGUNTAS PARA LA VISITA',
        timeline: 'CRONOLOGÍA',
      },
      en: {
        mainConcern: 'MAIN CONCERN',
        onset: 'ONSET / DURATION',
        pattern: 'PATTERN / SEVERITY',
        factors: 'WHAT HELPS / WORSENS',
        medications: 'CURRENT MEDICATIONS',
        questions: 'QUESTIONS FOR VISIT',
        timeline: 'TIMELINE',
      },
      pt: {
        mainConcern: 'QUEIXA PRINCIPAL',
        onset: 'INÍCIO / DURAÇÃO',
        pattern: 'PADRÃO / GRAVIDADE',
        factors: 'O QUE AJUDA / PIORA',
        medications: 'MEDICAMENTOS ATUAIS',
        questions: 'PERGUNTAS PARA A CONSULTA',
        timeline: 'CRONOLOGIA',
      },
      fr: {
        mainConcern: 'MOTIF PRINCIPAL',
        onset: 'DÉBUT / DURÉE',
        pattern: 'SCHÉMA / GRAVITÉ',
        factors: 'CE QUI AIDE / AGGRAVE',
        medications: 'MÉDICAMENTS ACTUELS',
        questions: 'QUESTIONS POUR LA VISITE',
        timeline: 'CHRONOLOGIE',
      },
    };

    const headers = allHeaders[detectedLang] || allHeaders.en!;
    const languageNames: Record<string, string> = { es: 'Spanish', en: 'English', pt: 'Portuguese', fr: 'French' };
    const languageName = languageNames[detectedLang] || 'English';

    // Simplified labels for cleaner summaries
    const simpleLabels: Record<string, { concern: string; started: string; location: string; character: string; severity: string; pattern: string; helps: string; worsens: string; meds: string }> = {
      es: { concern: 'Motivo', started: 'Inicio', location: 'Ubicación', character: 'Carácter', severity: 'Severidad', pattern: 'Patrón', helps: 'Mejora con', worsens: 'Empeora con', meds: 'Medicamentos' },
      en: { concern: 'Concern', started: 'Started', location: 'Location', character: 'Character', severity: 'Severity', pattern: 'Pattern', helps: 'Helps', worsens: 'Worsens', meds: 'Medications' },
      pt: { concern: 'Queixa', started: 'Início', location: 'Localização', character: 'Caráter', severity: 'Gravidade', pattern: 'Padrão', helps: 'Melhora com', worsens: 'Piora com', meds: 'Medicamentos' },
      fr: { concern: 'Motif', started: 'Début', location: 'Localisation', character: 'Caractère', severity: 'Sévérité', pattern: 'Schéma', helps: 'Améliore', worsens: 'Aggrave', meds: 'Médicaments' },
    };
    const sl = simpleLabels[detectedLang] || simpleLabels.en!;

    const focusInstruction = focusTopic
      ? `\n- CRITICAL: This note is ONLY about "${focusTopic}". Do NOT include Location, Severity, Pattern, or any other field data from a different health concern. If a piece of information (like a body location or severity rating) was shared about a DIFFERENT health topic, you MUST exclude it from this note entirely.`
      : '';

    const prompt = currentSummary
      ? `You are CareLog, a calm health documentation companion. Update this health note based on new information.

CURRENT NOTE:
${currentSummary}

NEW INFORMATION:
${conversationText}

Generate a CLEAN, doctor-ready health note. Use this format (include only fields with actual data):

${sl.concern}: [what's happening, using the person's own words]
${sl.started}: [when it began]
${sl.location}: [where they feel it]
${sl.character}: [how it feels — sharp, dull, throbbing, etc.]
${sl.severity}: [how bad, on their scale or 1-10]
${sl.pattern}: [timing, frequency, constant vs intermittent]
${sl.helps}: [what makes it better, if mentioned]
${sl.worsens}: [what makes it worse, if mentioned]
${sl.meds}: [any medications, if mentioned]

Rules:
- Include only fields where information was actually provided (typically 4-7 fields)
- Do NOT include fields where information is unknown — never write "not provided" or "N/A"
- Use the person's exact words and language when possible — this is THEIR record
- Keep each field to 1-2 lines max
- No headers like "MOTIVO PRINCIPAL" — use simple labels only
- No bullet points or complex formatting
- No medical jargon unless the person used it first
- Write in ${languageName}${focusInstruction}`
      : `You are CareLog, a calm health documentation companion. Create a doctor-ready health note from this conversation.

CONVERSATION:
${conversationText}

Generate a CLEAN, doctor-ready health note. Use this format (include only fields with actual data):

${sl.concern}: [what's happening, using the person's own words]
${sl.started}: [when it began]
${sl.location}: [where they feel it]
${sl.character}: [how it feels — sharp, dull, throbbing, etc.]
${sl.severity}: [how bad, on their scale or 1-10]
${sl.pattern}: [timing, frequency, constant vs intermittent]
${sl.helps}: [what makes it better, if mentioned]
${sl.worsens}: [what makes it worse, if mentioned]
${sl.meds}: [any medications, if mentioned]

Rules:
- Include only fields where information was actually provided (typically 4-7 fields)
- Do NOT include fields where information is unknown — never write "not provided" or "N/A"
- Use the person's exact words and language when possible — this is THEIR record
- Keep each field to 1-2 lines max
- No headers like "MOTIVO PRINCIPAL" — use simple labels only
- No bullet points or complex formatting
- No medical jargon unless the person used it first
- Write in ${languageName}${focusInstruction}`;

    try {
      // Use Sonnet for summaries (cost-effective for structured output)
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('\n');

      return content.trim();
    } catch (error) {
      const err = error as Error;
      // If summary generation fails, log and return current summary or empty
      logger.error({ err, currentSummary: !!currentSummary }, 'Failed to generate summary');
      return currentSummary || '';
    }
  }

  /**
   * Detect the main health concern topic from conversation messages.
   * Uses Claude Haiku for fast, lightweight extraction.
   * Returns a short title like "Back pain", "Eye sty", "Headaches"
   */
  async detectConcernTitle(messages: Message[], language?: string, existingConcernTitles?: string[]): Promise<string> {
    await this.rateLimiter.acquire();

    const langName = language === 'es' ? 'Spanish' : language === 'pt' ? 'Portuguese' : language === 'fr' ? 'French' : 'English';

    // Include the FIRST user message as anchor (the initial complaint) + recent messages
    const firstUserMessage = messages.find(m => m.role === 'user');
    const recentMessages = messages.slice(-6);
    let conversationText = '';
    if (firstUserMessage && !recentMessages.includes(firstUserMessage)) {
      conversationText = `User (first message): ${firstUserMessage.content}\n\n...\n\n`;
    }
    conversationText += recentMessages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    // Build existing concerns context
    const existingContext = existingConcernTitles && existingConcernTitles.length > 0
      ? `\nEXISTING CONCERNS for this user: ${existingConcernTitles.map(t => `"${t}"`).join(', ')}\n- If the conversation is about the SAME condition as an existing concern, return the topic name in ${langName} (translate if existing title is in a different language)\n- Only return a NEW title if the user is clearly discussing a DIFFERENT, UNRELATED health issue\n`
      : '';

    const prompt = `What health topic(s) are being discussed in this conversation? Return the topic name(s) (2-5 words each, in ${langName}).
${existingContext}
IMPORTANT RULES:
- Use a SIMPLE, STABLE name for the condition — the kind of name a patient would use, not a clinical diagnosis
- Do NOT change the topic name as more details emerge. "Headaches" stays "Headaches" even if the user later mentions visual symptoms or aura
- Do NOT upgrade to clinical terms. If the user said "headaches", return "Headaches" — NOT "Migraines With Aura"
- Focus on the BODY PART or BASIC SYMPTOM, not the specific sub-type
- When the user reports MULTIPLE RELATED symptoms (e.g., insomnia + palpitations + weight loss, or headache + nausea + light sensitivity), these are part of ONE concern — use a name that captures the primary complaint, not each individual symptom
- NEVER create separate concerns for symptoms that are part of the same clinical picture
- CRITICAL: Individual symptoms (cough, fever, headache, nausea, fatigue, body aches) that are discussed IN THE CONTEXT of a broader condition (flu, cold, COVID, infection) are NOT separate concerns. Always use the BROADER condition name, not the individual symptom. Example: if user says "I have the flu" and later mentions "I have a cough" — the topic is STILL "Flu", NOT "Cough"
- When an existing concern already captures a disease/condition, ANY symptoms discussed in the same conversation belong to that existing concern — return the EXISTING title
- BUT if the user mentions CLEARLY UNRELATED health issues (different body parts/systems, e.g., back pain AND a skin rash), return EACH topic on a SEPARATE LINE
- Only split into multiple topics when conditions are truly independent — not when one might cause the other

Examples:
- Single concern: "Flu" (even if user mentions cough, fever, body aches — these are symptoms of flu)
- Single concern: "Back Pain"
- Single concern: "Dolores de cabeza" (even if user also mentions nausea — related symptom)
- Two concerns (on separate lines):
Back Pain
Skin Rash

CONVERSATION:
${conversationText}

Topic name(s):`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content
        .filter(block => block.type === 'text')
        .map(block => (block as { type: 'text'; text: string }).text)
        .join('')
        .trim();

      // Clean up each line (may be multiple titles for unrelated concerns)
      const lines = content.split('\n').map(line => line.trim()).filter(l => l.length > 0);
      const cleanedLines = lines.map(line => {
        let title = line
          .replace(/^[-•*\d.)\s]+/, '')  // Remove list markers
          .replace(/^["']+|["']+$/g, '')  // Remove quotes
          .replace(/^(the |el |la |le |o )/i, '')  // Remove articles
          .trim();

        // Capitalize first letter of each word
        title = title.split(' ')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join(' ');

        return title;
      }).filter(t => t.length >= 2 && t.length <= 60);

      if (cleanedLines.length === 0) {
        return 'Health concern';
      }

      return cleanedLines.join('\n');
    } catch (error) {
      logger.error({ error }, 'Failed to detect concern title');
      return 'Health concern';
    }
  }

  /**
   * Segment conversation messages by health topic.
   * For multi-concern conversations, assigns each user message to its corresponding topic,
   * then includes all "shared" messages (greetings, meta) and assistant responses for context.
   * Returns a map of topic -> segmented messages for that topic.
   * On error, returns empty object to signal fallback to full messages.
   */
  async segmentMessagesByTopic(
    messages: Message[],
    topicTitles: string[],
    language?: string
  ): Promise<Record<string, Message[]>> {
    await this.rateLimiter.acquire();

    // Build conversation with numbered messages for classification
    const numberedMessages = messages
      .map((m, i) => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        return `${i}: [${role}] ${m.content}`;
      })
      .join('\n\n');

    const topicsJson = topicTitles.map(t => `"${t}"`).join(', ');
    const langName = language === 'es' ? 'Spanish' : language === 'pt' ? 'Portuguese' : language === 'fr' ? 'French' : 'English';

    const prompt = `You are segmenting a conversation by health topic.

CONVERSATION:
${numberedMessages}

TOPICS TO CLASSIFY:
${topicTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}

For EACH USER MESSAGE (numbered 0, 2, 4, etc), assign it to ONE of the topics above, or to "shared" if it's a greeting/meta/not health-related.

Respond with ONLY a JSON object mapping message index to topic name. Example:
{"0": "Headaches", "2": "Headaches", "4": "Back Pain", "5": "shared"}

STRICT RULES:
- Classify ONLY user messages (even-numbered: 0, 2, 4, 6...)
- For each user message, pick exactly ONE topic name or "shared"
- Topic names must EXACTLY match the provided list
- "shared" is for non-health conversation, greetings, or meta
- Output ONLY valid JSON, no explanation`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content
        .filter(block => block.type === 'text')
        .map(block => (block as { type: 'text'; text: string }).text)
        .join('')
        .trim();

      // Parse JSON response
      const classification = JSON.parse(content) as Record<string, string>;

      // Build segmented messages for each topic
      const segmented: Record<string, Message[]> = {};
      for (const topic of topicTitles) {
        segmented[topic] = [];
      }

      // Add shared messages to all topics
      const sharedMessages = messages.filter((_, i) => {
        const classif = classification[i.toString()];
        return classif === 'shared' || classif === undefined;
      });

      // For each topic, collect its user messages + following assistant messages + all shared messages
      for (const topic of topicTitles) {
        const topicMessages: Message[] = [];

        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i]!;
          const classif = classification[i.toString()];

          // Include if it's assigned to this topic
          if (classif === topic) {
            topicMessages.push(msg);
            // Also include following assistant message if it exists
            if (i + 1 < messages.length && messages[i + 1]!.role === 'assistant') {
              topicMessages.push(messages[i + 1]!);
            }
          }
        }

        // Add all shared messages
        topicMessages.push(...sharedMessages);

        // Sort by original message order
        const originalIndices = new Map<Message, number>();
        messages.forEach((msg, i) => originalIndices.set(msg, i));
        topicMessages.sort((a, b) => (originalIndices.get(a) ?? 0) - (originalIndices.get(b) ?? 0));

        // Remove duplicates while preserving order
        const seen = new Set<string>();
        const unique: Message[] = [];
        for (const msg of topicMessages) {
          const key = `${msg.role}:${msg.content}`;
          if (!seen.has(key)) {
            seen.add(key);
            unique.push(msg);
          }
        }

        segmented[topic] = unique;
      }

      return segmented;
    } catch (error) {
      // JSON parse or API error — return empty to signal fallback
      logger.error({ error }, 'Failed to segment messages by topic');
      return {};
    }
  }

  /**
   * Language detection based on common words in messages
   * Supports: Spanish, English, Portuguese, French
   */
  private detectLanguage(messages: Message[]): string {
    const text = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content.toLowerCase())
      .join(' ');

    // Spanish indicators
    const spanishWords = ['hola', 'tengo', 'estoy', 'dolor', 'desde', 'cuando', 'porque', 'médico', 'doctor', 'gracias', 'por favor', 'síntoma', 'siento', 'cabeza', 'cuerpo', 'hace', 'días', 'semana', 'buenos', 'buenas', 'qué', 'cómo'];
    const spanishCount = spanishWords.filter((w) => text.includes(w)).length;

    // English indicators
    const englishWords = ['hello', 'hi', 'have', 'feel', 'pain', 'since', 'when', 'because', 'doctor', 'thanks', 'thank', 'please', 'symptom', 'head', 'body', 'days', 'week', 'been', 'feeling', 'good', 'morning', 'what', 'how'];
    const englishCount = englishWords.filter((w) => text.includes(w)).length;

    // Portuguese indicators
    const portugueseWords = ['olá', 'oi', 'tenho', 'estou', 'dor', 'desde', 'quando', 'porque', 'médico', 'obrigado', 'obrigada', 'por favor', 'sintoma', 'sinto', 'cabeça', 'corpo', 'dias', 'semana', 'bom', 'boa', 'como', 'você'];
    const portugueseCount = portugueseWords.filter((w) => text.includes(w)).length;

    // French indicators
    const frenchWords = ['bonjour', 'salut', 'j\'ai', 'je suis', 'douleur', 'depuis', 'quand', 'parce', 'médecin', 'docteur', 'merci', 's\'il vous plaît', 'symptôme', 'tête', 'corps', 'jours', 'semaine', 'comment', 'bien', 'mal'];
    const frenchCount = frenchWords.filter((w) => text.includes(w)).length;

    // Find the language with highest count
    const scores = [
      { lang: 'es', count: spanishCount },
      { lang: 'en', count: englishCount },
      { lang: 'pt', count: portugueseCount },
      { lang: 'fr', count: frenchCount },
    ];

    const sorted = scores.sort((a, b) => b.count - a.count);

    // If no clear winner (all zero or tie), default to English
    if (sorted[0]!.count === 0 || (sorted[0]!.count === sorted[1]!.count)) {
      return 'en';
    }

    return sorted[0]!.lang;
  }
}
