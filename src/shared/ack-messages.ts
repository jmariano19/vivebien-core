/**
 * Plato Inteligente — Smart Ack Messages
 *
 * Generates personalized acknowledgments that MIRROR what the user said.
 * Uses ONE tiny Haiku call (~$0.001) to generate a warm, short ack.
 * Falls back to template acks if the AI call fails.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../infra/logging/logger';

const client = new Anthropic({
  apiKey: config.anthropicApiKey,
});

// ============================================================================
// Fallback Templates (used if Haiku call fails)
// ============================================================================

const FALLBACK_INPUT_ACKS: Record<string, string[]> = {
  es: [
    'Anotado 📋',
    'Lo tengo. Va para tu resumen de esta noche.',
    'Recibido ✓ Lo incluyo en tu análisis de hoy.',
  ],
  en: [
    'Got it 📋',
    "Noted. It'll be in your summary tonight.",
    'Received ✓ Adding it to today\'s analysis.',
  ],
  pt: [
    'Anotado 📋',
    'Recebi. Vai pro seu resumo de hoje à noite.',
  ],
  fr: [
    'Noté 📋',
    'Reçu. Ça sera dans votre résumé ce soir.',
  ],
};

const FALLBACK_QUESTION_ACKS: Record<string, string[]> = {
  es: [
    'Buena pregunta 👀 Te la respondo en tu resumen de esta noche.',
    'Me la apunto. Esta noche te doy la respuesta con contexto.',
  ],
  en: [
    "Good question 👀 I'll answer it in your summary tonight.",
    "Noted that one. Tonight's summary will have your answer.",
  ],
  pt: [
    'Boa pergunta 👀 Respondo no seu resumo de hoje à noite.',
  ],
  fr: [
    'Bonne question 👀 Je vous réponds dans votre résumé ce soir.',
  ],
};

// ============================================================================
// Question Detection
// ============================================================================

const QUESTION_STARTERS: Record<string, string[]> = {
  es: ['qué', 'que', 'cómo', 'como', 'por qué', 'por que', 'cuándo', 'cuando', 'dónde', 'donde', 'cuál', 'cual', 'cuánto', 'cuanto', 'puedo', 'debo', 'es bueno', 'es malo', 'se puede'],
  en: ['what', 'how', 'why', 'when', 'where', 'which', 'can', 'should', 'is it', 'do i', 'does', 'will', 'could', 'would'],
  pt: ['que', 'como', 'por que', 'quando', 'onde', 'qual', 'posso', 'devo'],
  fr: ['que', 'comment', 'pourquoi', 'quand', 'où', 'ou', 'quel', 'quelle', 'est-ce', 'puis-je'],
};

export function isQuestion(message: string): boolean {
  if (message.includes('?')) return true;

  const lower = message.toLowerCase().trim();
  for (const starters of Object.values(QUESTION_STARTERS)) {
    for (const starter of starters) {
      if (lower.startsWith(starter + ' ') || lower === starter) {
        return true;
      }
    }
  }

  return false;
}

// ============================================================================
// Smart Ack Generator (Haiku)
// ============================================================================

/**
 * Generate a personalized ack that mirrors the user's message.
 * Uses Haiku for ~$0.001 per call. Falls back to templates on failure.
 */
export async function getSmartAck(
  userMessage: string,
  language: string,
  isQuestionMsg: boolean,
): Promise<string> {
  try {
    const lang = language || 'es';
    const langName = { es: 'Spanish', en: 'English', pt: 'Portuguese', fr: 'French' }[lang] || 'Spanish';

    const prompt = isQuestionMsg
      ? `The user sent this health-related question via WhatsApp: "${userMessage}"

Generate a SHORT (1-2 sentences max) warm acknowledgment in ${langName} that:
1. Shows you understood their specific question
2. Tells them the answer will be in their nightly summary tonight

Example style: "Entiendo tu pregunta sobre el dolor de cabeza. Esta noche te damos contexto en tu resumen."
Do NOT answer the question. Just acknowledge it.`
      : `The user sent this health-related message via WhatsApp: "${userMessage}"

Generate a SHORT (1-2 sentences max) warm acknowledgment in ${langName} that:
1. Mirrors/reflects what they shared (show you understood the specific thing)
2. Tells them it's noted for their nightly summary

Example style: "Anotado lo del arroz con pollo 📋 Lo incluimos en tu resumen de esta noche."
Do NOT give health advice. Just acknowledge.`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content && content.type === 'text' && content.text.trim()) {
      return content.text.trim();
    }

    // Fallback if response is empty
    return getFallbackAck(lang, isQuestionMsg);
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message }, 'Smart ack failed, using fallback template');
    return getFallbackAck(language || 'es', isQuestionMsg);
  }
}

/**
 * Pick a random fallback ack (no AI needed).
 */
export function getFallbackAck(language: string, isQuestionMsg: boolean): string {
  const lang = language in FALLBACK_INPUT_ACKS ? language : 'es';
  const pool = isQuestionMsg
    ? (FALLBACK_QUESTION_ACKS[lang] || FALLBACK_QUESTION_ACKS.es!)
    : (FALLBACK_INPUT_ACKS[lang] || FALLBACK_INPUT_ACKS.es!);

  return pool[Math.floor(Math.random() * pool.length)]!;
}

// Keep old function name for backward compatibility
export function getAckMessage(language: string, isQuestionMsg: boolean): string {
  return getFallbackAck(language, isQuestionMsg);
}
