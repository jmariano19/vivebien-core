"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VoiceService = void 0;
const config_1 = require("../../config");
const logger_1 = require("../../infra/logging/logger");
class VoiceService {
    apiKey;
    defaultVoiceId;
    constructor() {
        this.apiKey = config_1.config.elevenLabsApiKey;
        this.defaultVoiceId = config_1.config.elevenLabsVoiceId;
    }
    /**
     * Check if voice synthesis is available
     */
    isAvailable() {
        return !!(this.apiKey && this.defaultVoiceId);
    }
    /**
     * Synthesize text to speech using ElevenLabs API.
     * Returns the audio buffer (MP3 format).
     */
    async synthesizeSpeech(text, voiceId, language) {
        if (!this.apiKey) {
            logger_1.logger.warn('ElevenLabs API key not configured, skipping voice synthesis');
            return null;
        }
        const targetVoiceId = voiceId || this.defaultVoiceId;
        if (!targetVoiceId) {
            logger_1.logger.warn('No voice ID configured for ElevenLabs');
            return null;
        }
        try {
            logger_1.logger.info({ voiceId: targetVoiceId, textLength: text.length }, 'Starting voice synthesis');
            const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${targetVoiceId}`, {
                method: 'POST',
                headers: {
                    'Accept': 'audio/mpeg',
                    'Content-Type': 'application/json',
                    'xi-api-key': this.apiKey,
                },
                body: JSON.stringify({
                    text,
                    model_id: 'eleven_multilingual_v2', // Supports Spanish, English, Portuguese, French
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                        style: 0.3, // Slight expressiveness for warmth
                        use_speaker_boost: true,
                    },
                }),
            });
            if (!response.ok) {
                const errorText = await response.text();
                logger_1.logger.error({ status: response.status, error: errorText }, 'ElevenLabs API error');
                return null;
            }
            const audioBuffer = Buffer.from(await response.arrayBuffer());
            // Rough estimate: ~150 words per minute, average word = 5 chars + space
            const wordCount = text.split(/\s+/).length;
            const durationEstimate = Math.ceil((wordCount / 150) * 60);
            logger_1.logger.info({ audioSize: audioBuffer.length, durationEstimate }, 'Voice synthesis complete');
            return {
                audioBuffer,
                contentType: 'audio/mpeg',
                durationEstimate,
            };
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Failed to synthesize speech');
            return null;
        }
    }
    /**
     * Generate a warm, personal digest script from pattern summary.
     * This creates the text that will be spoken by the voice.
     */
    generateDigestScript(patterns, mealCount, language, userName) {
        const name = userName || '';
        const greeting = name ? `${name}, ` : '';
        if (language === 'es') {
            const intro = `${greeting}aquí está tu resumen del día.`;
            const mealNote = mealCount > 0
                ? `Hoy registraste ${mealCount} comida${mealCount > 1 ? 's' : ''}.`
                : 'Hoy no registraste comidas.';
            const patternNote = patterns.length > 0
                ? `Algo que noté: ${patterns[0]}`
                : 'Sigue compartiendo lo que comes para que pueda encontrar patrones útiles.';
            const closing = 'Mañana seguimos. Tú decides qué comer.';
            return `${intro} ${mealNote} ${patternNote} ${closing}`;
        }
        if (language === 'pt') {
            const intro = `${greeting}aqui está seu resumo do dia.`;
            const mealNote = mealCount > 0
                ? `Hoje você registrou ${mealCount} refeição${mealCount > 1 ? 'ões' : ''}.`
                : 'Hoje não houve refeições registradas.';
            const patternNote = patterns.length > 0
                ? `Algo que notei: ${patterns[0]}`
                : 'Continue compartilhando o que come para eu encontrar padrões úteis.';
            const closing = 'Amanhã continuamos. Você decide o que comer.';
            return `${intro} ${mealNote} ${patternNote} ${closing}`;
        }
        if (language === 'fr') {
            const intro = `${greeting}voici votre résumé du jour.`;
            const mealNote = mealCount > 0
                ? `Aujourd'hui vous avez enregistré ${mealCount} repas.`
                : "Aujourd'hui, aucun repas n'a été enregistré.";
            const patternNote = patterns.length > 0
                ? `Quelque chose que j'ai remarqué: ${patterns[0]}`
                : 'Continuez à partager ce que vous mangez pour que je puisse trouver des tendances utiles.';
            const closing = 'On continue demain. Vous décidez quoi manger.';
            return `${intro} ${mealNote} ${patternNote} ${closing}`;
        }
        // English default
        const intro = `${greeting}here's your daily summary.`;
        const mealNote = mealCount > 0
            ? `Today you logged ${mealCount} meal${mealCount > 1 ? 's' : ''}.`
            : 'No meals were logged today.';
        const patternNote = patterns.length > 0
            ? `Something I noticed: ${patterns[0]}`
            : 'Keep sharing what you eat so I can find useful patterns.';
        const closing = "We'll keep going tomorrow. You decide what to eat.";
        return `${intro} ${mealNote} ${patternNote} ${closing}`;
    }
}
exports.VoiceService = VoiceService;
//# sourceMappingURL=service.js.map