/**
 * Plato Inteligente — Smart Ack Messages
 *
 * Generates personalized acknowledgments that MIRROR what the user said.
 * Uses ONE tiny Haiku call (~$0.001) to generate a warm, short ack.
 * Falls back to template acks if the AI call fails.
 * Image-only messages skip AI entirely and use image templates.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../infra/logging/logger';

const client = new Anthropic({
  apiKey: config.anthropicApiKey,
});

// ============================================================================
// Image Ack Templates (no AI needed — just acknowledge the photo)
// ============================================================================

const IMAGE_ACKS: Record<string, string[]> = {
  es: [
    'Foto recibida 📸 La analizamos en tu resumen de esta noche.',
    'Imagen guardada 📸 Esta noche la revisamos con detalle.',
    'Recibida tu foto 📸 La incluimos en el análisis de hoy.',
  ],
  en: [
    'Photo received 📸 We\'ll analyze it in your summary tonight.',
    'Image saved 📸 We\'ll review it in detail tonight.',
    'Got your photo 📸 Including it in today\'s analysis.',
  ],
  pt: [
    'Foto recebida 📸 Analisamos no seu resumo de hoje à noite.',
    'Imagem guardada 📸 Revisamos com detalhe hoje à noite.',
  ],
  fr: [
    'Photo reçue 📸 On l\'analyse dans votre résumé ce soir.',
    'Image enregistrée 📸 On la revoit en détail ce soir.',
  ],
};

// ============================================================================
// Fallback Templates (used if Haiku call fails)
// ============================================================================

const FALLBACK_INPUT_ACKS: Record<string, string[]> = {
  es: [
    'Listo, lo tengo 👍',
    'Va quedando el registro del día.',
    'Perfecto, queda registrado.',
    'Ahí va 📋',
    'Recibido ✓',
  ],
  en: [
    'Got it 👍',
    'Logged for the day.',
    'Perfect, noted.',
    'Received ✓',
    'All good 📋',
  ],
  pt: [
    'Beleza, anotei 👍',
    'Registrado pro dia.',
    'Recebi ✓',
  ],
  fr: [
    'C\'est noté 👍',
    'Bien reçu.',
    'Enregistré ✓',
  ],
};

const FALLBACK_QUESTION_ACKS: Record<string, string[]> = {
  es: [
    'Buena pregunta 👀',
    'Interesante, lo revisamos.',
    'Me la apunto 🤔',
  ],
  en: [
    'Good question 👀',
    'Interesting one, noted.',
    "I'll look into that 🤔",
  ],
  pt: [
    'Boa pergunta 👀',
    'Interessante, anoto aqui.',
  ],
  fr: [
    'Bonne question 👀',
    'Intéressant, je note.',
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
 * Check if the message is image-only (no real text content from the user).
 */
function isImageOnlyMessage(message: string): boolean {
  const cleaned = message
    .replace(/\[Image attached\]/gi, '')
    .replace(/\[Image description\]:.*$/gm, '')
    .trim();
  return cleaned.length === 0;
}

/**
 * Get a random image ack template.
 */
function getImageAck(language: string): string {
  const lang = language in IMAGE_ACKS ? language : 'es';
  const pool = IMAGE_ACKS[lang] || IMAGE_ACKS.es!;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * Generate a personalized ack that mirrors the user's message.
 * - Image-only messages: use template (no AI)
 * - Text messages: use Haiku (~$0.001) to mirror what they said
 * - Falls back to templates on any failure
 */
export async function getSmartAck(
  userMessage: string,
  language: string,
  isQuestionMsg: boolean,
  hasImage: boolean = false,
): Promise<string> {
  const lang = language || 'es';

  // Image-only messages: skip AI, use template
  if (hasImage && isImageOnlyMessage(userMessage)) {
    return getImageAck(lang);
  }

  // Strip image markers from the text before sending to Haiku
  const cleanMessage = userMessage
    .replace(/\[Image attached\]/gi, '')
    .replace(/\[Image description\]:.*$/gm, '')
    .trim();

  // If after cleaning there's no meaningful text, use fallback
  if (!cleanMessage) {
    return hasImage ? getImageAck(lang) : getFallbackAck(lang, isQuestionMsg);
  }

  try {
    const langName = { es: 'Spanish', en: 'English', pt: 'Portuguese', fr: 'French' }[lang] || 'Spanish';
    const imageNote = hasImage ? ' They also sent a photo.' : '';

    const prompt = isQuestionMsg
      ? `You are a warm WhatsApp nutrition companion. The user sent: "${cleanMessage}"${imageNote}

Write a SHORT ack (1 sentence, max 15 words) in ${langName} that:
- Shows you understood their specific question
- Feels like a friend texting back, not a robot

RULES:
- NEVER start with "Anotado" or "Noted" — vary your openings
- NEVER mention "resumen", "summary", or "tonight" — just acknowledge warmly
- Use 1 emoji max, and not always the same one
- Keep it casual and warm like WhatsApp

Vary your style. Examples of good variety:
- "Buena pregunta sobre las grasas 🤔"
- "Ah, eso del azúcar es interesante — lo revisamos."
- "Ojo con eso, te cuento más luego 👀"

Reply ONLY with the ack. No quotes.`
      : `You are a warm WhatsApp nutrition companion. The user sent: "${cleanMessage}"${imageNote}

Write a SHORT ack (1 sentence, max 15 words) in ${langName} that:
- Reflects back what they shared using THEIR words
- Feels like a friend texting back, not a system confirmation

RULES:
- NEVER start with "Anotado" — vary your openings every time
- NEVER say "lo incluimos en tu resumen" or "tonight's summary" — just acknowledge warmly
- Use 1 emoji max, and vary which emoji you use
- Match their energy — if they're casual, be casual

Vary your style. Examples of good variety:
- "Huevos con tortilla, clásico 💪"
- "Rica esa combinación de pollo con ensalada."
- "4 vasos de agua, bien ahí 💧"
- "Tacos con aguacate suena increíble 🤤"
- "Eso se escucha pesado, descansa bien."

Reply ONLY with the ack. No quotes.`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content && content.type === 'text' && content.text.trim()) {
      // Strip any wrapping quotes that Haiku might add
      let ack = content.text.trim();
      if ((ack.startsWith('"') && ack.endsWith('"')) || (ack.startsWith('"') && ack.endsWith('"'))) {
        ack = ack.slice(1, -1);
      }
      return ack;
    }

    return getFallbackAck(lang, isQuestionMsg);
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message }, 'Smart ack failed, using fallback template');
    return getFallbackAck(lang, isQuestionMsg);
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
