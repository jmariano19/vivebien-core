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

      // Call Claude
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
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
    const isSpanish = detectedLang === 'es' || detectedLang === 'spanish';

    const conversationText = messages
      .map((m) => `${m.role === 'user' ? (isSpanish ? 'Usuario' : 'User') : (isSpanish ? 'Asistente' : 'Assistant')}: ${m.content}`)
      .join('\n\n');

    // Language-specific section headers
    const headers = isSpanish ? {
      symptoms: 'SÍNTOMAS REGISTRADOS',
      medications: 'MEDICAMENTOS / TRATAMIENTOS',
      questions: 'PREGUNTAS PARA EL MÉDICO',
      changes: 'CAMBIOS DESDE ÚLTIMA VISITA',
      changesRecent: 'CAMBIOS RECIENTES',
      nextSteps: 'PRÓXIMOS PASOS',
    } : {
      symptoms: 'LOGGED SYMPTOMS',
      medications: 'MEDICATIONS / TREATMENTS',
      questions: 'QUESTIONS FOR DOCTOR',
      changes: 'CHANGES SINCE LAST VISIT',
      changesRecent: 'RECENT CHANGES',
      nextSteps: 'NEXT STEPS',
    };

    const prompt = currentSummary
      ? `You are Care Log. Update the following health record based on recent entries.

CURRENT RECORD:
${currentSummary}

RECENT ENTRIES:
${conversationText}

Generate an updated record. Use this format (include only sections with information):

${headers.symptoms}
- [symptom]: [when started], [frequency], [severity if mentioned]

${headers.medications}
- [medication/treatment]: [dosage if known], [frequency]

${headers.questions}
- [question logged by user]

${headers.changes}
- [change noted]

${headers.nextSteps}
- [follow-up item]

Rules:
- Be factual, not emotional
- No reassurance language
- No emojis or exclamation marks
- If no new relevant information, keep previous record
- Write in ${isSpanish ? 'Spanish' : 'the same language as the conversation'}`
      : `You are Care Log. Create an initial health record based on the conversation.

ENTRIES:
${conversationText}

Generate a structured record. Use this format (include only sections with information):

${headers.symptoms}
- [symptom]: [when started], [frequency], [severity if mentioned]

${headers.medications}
- [medication/treatment]: [dosage if known], [frequency]

${headers.questions}
- [question logged by user]

${headers.changesRecent}
- [change noted]

${headers.nextSteps}
- [follow-up item]

Rules:
- Be factual, not emotional
- No reassurance language
- No emojis or exclamation marks
- Only include sections where information exists
- Write in ${isSpanish ? 'Spanish' : 'the same language as the conversation'}`;

    try {
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
   * Simple language detection based on common words in messages
   */
  private detectLanguage(messages: Message[]): string {
    const text = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content.toLowerCase())
      .join(' ');

    // Spanish indicators
    const spanishWords = ['hola', 'tengo', 'estoy', 'dolor', 'desde', 'cuando', 'porque', 'médico', 'doctor', 'gracias', 'por favor', 'síntoma', 'siento', 'cabeza', 'cuerpo', 'hace', 'días', 'semana'];
    const spanishCount = spanishWords.filter((w) => text.includes(w)).length;

    // English indicators
    const englishWords = ['hello', 'have', 'feel', 'pain', 'since', 'when', 'because', 'doctor', 'thanks', 'please', 'symptom', 'head', 'body', 'days', 'week', 'been', 'feeling'];
    const englishCount = englishWords.filter((w) => text.includes(w)).length;

    // Portuguese indicators
    const portugueseWords = ['olá', 'tenho', 'estou', 'dor', 'desde', 'quando', 'porque', 'médico', 'obrigado', 'por favor', 'sintoma', 'sinto', 'cabeça', 'corpo', 'dias', 'semana'];
    const portugueseCount = portugueseWords.filter((w) => text.includes(w)).length;

    if (portugueseCount > spanishCount && portugueseCount > englishCount) {
      return 'pt';
    }
    if (englishCount > spanishCount) {
      return 'en';
    }
    return 'es'; // Default to Spanish
  }
}
