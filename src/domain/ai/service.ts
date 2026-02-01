import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import { AIResponse, Message, ConversationContext, TokenUsage } from '../../shared/types';
import { AIServiceError } from '../../shared/errors';
import { logAIUsage } from '../../infra/logging/logger';
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
   */
  postProcess(content: string): string {
    let cleaned = content;

    // Remove markdown bold/italic that doesn't render well in WhatsApp
    cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, '$1');
    cleaned = cleaned.replace(/\*(.+?)\*/g, '$1');
    cleaned = cleaned.replace(/_(.+?)_/g, '$1');

    // Remove code blocks
    cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
    cleaned = cleaned.replace(/`(.+?)`/g, '$1');

    // Remove headers
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

    const label = labels[detectedLang] || labels.en;
    const conversationText = messages
      .map((m) => `${m.role === 'user' ? label.user : label.assistant}: ${m.content}`)
      .join('\n\n');

    // Language-specific section headers (doctor-ready format)
    const allHeaders: Record<string, typeof headers> = {
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

    const headers = allHeaders[detectedLang] || allHeaders.en;
    const languageNames: Record<string, string> = { es: 'Spanish', en: 'English', pt: 'Portuguese', fr: 'French' };
    const languageName = languageNames[detectedLang] || 'English';

    const prompt = currentSummary
      ? `You are Confianza. Update this doctor-ready health record based on recent entries.

CURRENT RECORD:
${currentSummary}

RECENT ENTRIES:
${conversationText}

Generate an updated doctor-ready record. Use this format (include only sections with information):

${headers.mainConcern}
[Primary symptom or health issue in one clear sentence]

${headers.onset}
[When it started, how long it has lasted]

${headers.pattern}
[How often, how severe, any patterns noticed]

${headers.factors}
- Helps: [what makes it better]
- Worsens: [what makes it worse]

${headers.medications}
- [medication]: [dosage], [frequency]

${headers.questions}
- [question 1]
- [question 2]
- [question 3]

${headers.timeline}
- [date/time]: [what happened]

Rules:
- Neutral, clinical language
- No diagnosis certainty
- Never invent data
- Mark unknowns as "not provided" or omit section
- Concise, scannable bullets
- No emojis or exclamation marks
- Write entirely in ${languageName}`
      : `You are Confianza. Create a doctor-ready health record from this conversation.

ENTRIES:
${conversationText}

Generate a structured doctor-ready record. Use this format (include only sections with information):

${headers.mainConcern}
[Primary symptom or health issue in one clear sentence]

${headers.onset}
[When it started, how long it has lasted]

${headers.pattern}
[How often, how severe, any patterns noticed]

${headers.factors}
- Helps: [what makes it better]
- Worsens: [what makes it worse]

${headers.medications}
- [medication]: [dosage], [frequency]

${headers.questions}
- [question 1]
- [question 2]
- [question 3]

Rules:
- Neutral, clinical language
- No diagnosis certainty
- Never invent data
- Mark unknowns as "not provided" or omit section
- Concise, scannable bullets
- No emojis or exclamation marks
- Only include sections where information exists
- Write entirely in ${languageName}`;

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
      // If summary generation fails, return current summary or empty
      console.error('Failed to generate summary:', err.message);
      return currentSummary || '';
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
    if (sorted[0].count === 0 || (sorted[0].count === sorted[1].count)) {
      return 'en';
    }

    return sorted[0].lang;
  }
}
