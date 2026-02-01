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
      // Get system prompt based on context
      const systemPrompt = await conversationService.getSystemPrompt(context);

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
  async generateSummary(messages: Message[], currentSummary: string | null): Promise<string> {
    await this.rateLimiter.acquire();

    const conversationText = messages
      .map((m) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content}`)
      .join('\n\n');

    const prompt = currentSummary
      ? `You are Care Log. Update the following health record based on recent entries.

CURRENT RECORD:
${currentSummary}

RECENT ENTRIES:
${conversationText}

Generate an updated record. Use this format (include only sections with information):

SÍNTOMAS REGISTRADOS
- [symptom]: [when started], [frequency], [severity if mentioned]

MEDICAMENTOS / TRATAMIENTOS
- [medication/treatment]: [dosage if known], [frequency]

PREGUNTAS PARA EL MÉDICO
- [question logged by user]

CAMBIOS DESDE ÚLTIMA VISITA
- [change noted]

PRÓXIMOS PASOS
- [follow-up item]

Rules:
- Be factual, not emotional
- No reassurance language
- No emojis or exclamation marks
- If no new relevant information, keep previous record
- Write in Spanish`
      : `You are Care Log. Create an initial health record based on the conversation.

ENTRIES:
${conversationText}

Generate a structured record. Use this format (include only sections with information):

SÍNTOMAS REGISTRADOS
- [symptom]: [when started], [frequency], [severity if mentioned]

MEDICAMENTOS / TRATAMIENTOS
- [medication/treatment]: [dosage if known], [frequency]

PREGUNTAS PARA EL MÉDICO
- [question logged by user]

CAMBIOS RECIENTES
- [change noted]

PRÓXIMOS PASOS
- [follow-up item]

Rules:
- Be factual, not emotional
- No reassurance language
- No emojis or exclamation marks
- Only include sections where information exists
- Write in Spanish`;

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
}
