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
   * @param content - The AI response content
   * @param userId - Optional user ID to add summary link
   * @param language - Optional language for the link text
   */
  postProcess(content: string, userId?: string, language?: string): string {
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

    // For summary messages: add containment reinforcement + link
    // This is enforced at the code level to guarantee Principle 5 (offload mental burden)
    if (userId && this.looksLikeSummary(cleaned) && !cleaned.includes('carelog.vivebien.io')) {
      const containmentText = this.getContainmentText(language || 'es');
      const linkText = this.getSummaryLinkText(language || 'es', userId);
      cleaned += '\n\n' + containmentText + '\n\n' + linkText;
    }

    // Limit response length (WhatsApp has a 4096 character limit)
    if (cleaned.length > 4000) {
      cleaned = cleaned.substring(0, 3997) + '...';
    }
    return cleaned;
  }

  /**
   * Check if the response looks like a summary
   */
  private looksLikeSummary(content: string): boolean {
    const summaryIndicators = [
      'resumen', 'summary', 'resumo', 'résumé',
      'motivo', 'concern', 'queixa', 'motif',
      'preguntas para', 'questions for', 'perguntas para', 'questions pour',
      'inicio:', 'onset:', 'início:', 'début:',
      'empeora con', 'worsens with', 'piora com', 'aggrave avec',
      '---', // Common separator in summaries
    ];

    const lowerContent = content.toLowerCase();
    const matchCount = summaryIndicators.filter(indicator =>
      lowerContent.includes(indicator.toLowerCase())
    ).length;

    // If 3+ indicators found, it's likely a summary
    return matchCount >= 3;
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
      es: `📋 Tu nota está aquí 👇\n${link}`,
      en: `📋 Your note is here 👇\n${link}`,
      pt: `📋 Sua nota está aqui 👇\n${link}`,
      fr: `📋 Votre note est ici 👇\n${link}`,
    };
    return texts[language] || texts.es!;
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
  async generateSummary(messages: Message[], currentSummary: string | null, language?: string): Promise<string> {
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
    const simpleLabels: Record<string, { concern: string; started: string; helps: string; worsens: string; meds: string }> = {
      es: { concern: 'Motivo', started: 'Inicio', helps: 'Mejora con', worsens: 'Empeora con', meds: 'Medicamentos' },
      en: { concern: 'Concern', started: 'Started', helps: 'Helps', worsens: 'Worsens', meds: 'Medications' },
      pt: { concern: 'Queixa', started: 'Início', helps: 'Melhora com', worsens: 'Piora com', meds: 'Medicamentos' },
      fr: { concern: 'Motif', started: 'Début', helps: 'Améliore', worsens: 'Aggrave', meds: 'Médicaments' },
    };
    const sl = simpleLabels[detectedLang] || simpleLabels.en!;

    const prompt = currentSummary
      ? `You are CareLog, a calm health documentation companion. Update this health note based on new information.

CURRENT NOTE:
${currentSummary}

NEW INFORMATION:
${conversationText}

Generate a SIMPLE, CLEAN health note. Use this format:

${sl.concern}: [what's happening, using the person's own words]
${sl.started}: [when it began]
${sl.helps}: [what makes it better, if mentioned]
${sl.worsens}: [what makes it worse, if mentioned]
${sl.meds}: [any medications, if mentioned]

Rules:
- Keep it SHORT and simple (no more than 5 lines)
- Use the person's exact words and language when possible — this is THEIR record
- ONLY include fields where information was actually provided
- Do NOT include fields where information is unknown — never write "not provided" or "N/A"
- No headers like "MOTIVO PRINCIPAL" — use simple labels only
- No bullet points or complex formatting
- No medical jargon unless the person used it first
- Write in ${languageName}`
      : `You are CareLog, a calm health documentation companion. Create a simple health note from this conversation.

CONVERSATION:
${conversationText}

Generate a SIMPLE, CLEAN health note. Use this format:

${sl.concern}: [what's happening, using the person's own words]
${sl.started}: [when it began]
${sl.helps}: [what makes it better, if mentioned]
${sl.worsens}: [what makes it worse, if mentioned]
${sl.meds}: [any medications, if mentioned]

Rules:
- Keep it SHORT and simple (no more than 5 lines)
- Use the person's exact words and language when possible — this is THEIR record
- ONLY include fields where information was actually provided
- Do NOT include fields where information is unknown — never write "not provided" or "N/A"
- No headers like "MOTIVO PRINCIPAL" — use simple labels only
- No bullet points or complex formatting
- No medical jargon unless the person used it first
- Write in ${languageName}`;

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
  async detectConcernTitle(messages: Message[], language?: string): Promise<string> {
    await this.rateLimiter.acquire();

    const langName = language === 'es' ? 'Spanish' : language === 'pt' ? 'Portuguese' : language === 'fr' ? 'French' : 'English';

    // Use the last few messages for context
    const recentMessages = messages.slice(-6);
    const conversationText = recentMessages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    const prompt = `What is the MAIN health topic being discussed in this conversation? Return ONLY the topic name (2-5 words, in ${langName}).

Examples of good responses:
- Back pain
- Eye sty
- Persistent headaches
- Sore throat
- Knee injury
- Dolor de espalda
- Orzuelo en el ojo

CONVERSATION:
${conversationText}

Topic name:`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 30,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content
        .filter(block => block.type === 'text')
        .map(block => (block as { type: 'text'; text: string }).text)
        .join('')
        .trim();

      // Clean up the response
      let title = content
        .replace(/^["']+|["']+$/g, '')  // Remove quotes
        .replace(/^(the |el |la |le |o )/i, '')  // Remove articles
        .trim();

      // Capitalize first letter of each word
      title = title.split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');

      // Validate: should be 2-60 chars
      if (title.length < 2 || title.length > 60) {
        return 'Health concern';
      }

      return title;
    } catch (error) {
      logger.error({ error }, 'Failed to detect concern title');
      return 'Health concern';
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
