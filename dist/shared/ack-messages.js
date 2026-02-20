"use strict";
/**
 * Plato Inteligente — Smart Ack Messages
 *
 * Generates personalized acknowledgments that MIRROR what the user said.
 * Uses ONE tiny Haiku call (~$0.001) to generate a warm, short ack.
 * Falls back to template acks if the AI call fails.
 * Image-only messages skip AI entirely and use image templates.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isQuestion = isQuestion;
exports.getSmartAck = getSmartAck;
exports.getFallbackAck = getFallbackAck;
exports.getAckMessage = getAckMessage;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const config_1 = require("../config");
const logger_1 = require("../infra/logging/logger");
const client = new sdk_1.default({
    apiKey: config_1.config.anthropicApiKey,
});
// ============================================================================
// Image Ack Templates (no AI needed — just acknowledge the photo)
// ============================================================================
const IMAGE_ACKS = {
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
const FALLBACK_INPUT_ACKS = {
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
const FALLBACK_QUESTION_ACKS = {
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
const QUESTION_STARTERS = {
    es: ['qué', 'que', 'cómo', 'como', 'por qué', 'por que', 'cuándo', 'cuando', 'dónde', 'donde', 'cuál', 'cual', 'cuánto', 'cuanto', 'puedo', 'debo', 'es bueno', 'es malo', 'se puede'],
    en: ['what', 'how', 'why', 'when', 'where', 'which', 'can', 'should', 'is it', 'do i', 'does', 'will', 'could', 'would'],
    pt: ['que', 'como', 'por que', 'quando', 'onde', 'qual', 'posso', 'devo'],
    fr: ['que', 'comment', 'pourquoi', 'quand', 'où', 'ou', 'quel', 'quelle', 'est-ce', 'puis-je'],
};
function isQuestion(message) {
    if (message.includes('?'))
        return true;
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
function isImageOnlyMessage(message) {
    const cleaned = message
        .replace(/\[Image attached\]/gi, '')
        .replace(/\[Image description\]:.*$/gm, '')
        .trim();
    return cleaned.length === 0;
}
/**
 * Get a random image ack template.
 */
function getImageAck(language) {
    const lang = language in IMAGE_ACKS ? language : 'es';
    const pool = IMAGE_ACKS[lang] || IMAGE_ACKS.es;
    return pool[Math.floor(Math.random() * pool.length)];
}
/**
 * Generate a personalized ack that mirrors the user's message.
 * - Image-only messages: use template (no AI)
 * - Text messages: use Haiku (~$0.001) to mirror what they said
 * - Falls back to templates on any failure
 */
async function getSmartAck(userMessage, language, isQuestionMsg, hasImage = false) {
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
            ? `You are a WhatsApp health companion. The user sent this message: "${cleanMessage}"${imageNote}

Generate ONLY a short acknowledgment (1-2 sentences) in ${langName} that:
1. Shows you understood their specific question (mirror their words)
2. Says the answer will be in their nightly summary

Reply ONLY with the acknowledgment. No quotes, no explanation.
Example: "Entiendo tu pregunta sobre el dolor de cabeza. Esta noche te damos contexto en tu resumen."`
            : `You are a WhatsApp health companion. The user sent this message: "${cleanMessage}"${imageNote}

Generate ONLY a short acknowledgment (1-2 sentences) in ${langName} that:
1. Mirrors what they shared (repeat back the specific thing they mentioned)
2. Says it's noted for their nightly summary

Reply ONLY with the acknowledgment. No quotes, no explanation.
Example: "Anotado lo del arroz con pollo 📋 Lo incluimos en tu resumen de esta noche."`;
        const response = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 100,
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
    }
    catch (error) {
        const err = error;
        logger_1.logger.warn({ error: err.message }, 'Smart ack failed, using fallback template');
        return getFallbackAck(lang, isQuestionMsg);
    }
}
/**
 * Pick a random fallback ack (no AI needed).
 */
function getFallbackAck(language, isQuestionMsg) {
    const lang = language in FALLBACK_INPUT_ACKS ? language : 'es';
    const pool = isQuestionMsg
        ? (FALLBACK_QUESTION_ACKS[lang] || FALLBACK_QUESTION_ACKS.es)
        : (FALLBACK_INPUT_ACKS[lang] || FALLBACK_INPUT_ACKS.es);
    return pool[Math.floor(Math.random() * pool.length)];
}
// Keep old function name for backward compatibility
function getAckMessage(language, isQuestionMsg) {
    return getFallbackAck(language, isQuestionMsg);
}
//# sourceMappingURL=ack-messages.js.map