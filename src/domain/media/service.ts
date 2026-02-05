import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import { logger } from '../../infra/logging/logger';

export class MediaService {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic({
      apiKey: config.anthropicApiKey,
    });
  }

  /**
   * Transcribe audio using Claude's native audio understanding
   * @param audioUrl URL of the audio file to transcribe
   * @param language Optional language hint (e.g., 'es', 'en')
   */
  async transcribeAudio(audioUrl: string, language?: string): Promise<string> {
    try {
      logger.info({ audioUrl, language }, 'Starting audio transcription with Claude');

      // Download the audio file
      const audioResponse = await fetch(audioUrl);
      if (!audioResponse.ok) {
        throw new Error(`Failed to download audio: ${audioResponse.status}`);
      }

      const audioBuffer = await audioResponse.arrayBuffer();
      const base64Audio = Buffer.from(audioBuffer).toString('base64');

      // Determine media type from content-type header
      const contentType = audioResponse.headers.get('content-type') || 'audio/ogg';
      const mediaType = contentType.includes('mp3') ? 'audio/mpeg'
        : contentType.includes('wav') ? 'audio/wav'
        : contentType.includes('webm') ? 'audio/webm'
        : contentType.includes('mp4') ? 'audio/mp4'
        : 'audio/ogg';

      // Language-specific prompts for transcription
      const langPrompts: Record<string, string> = {
        es: 'Transcribe este mensaje de voz palabra por palabra en español. Solo devuelve la transcripción, sin explicaciones adicionales.',
        en: 'Transcribe this voice message word for word in English. Only return the transcription, no additional explanations.',
        pt: 'Transcreva esta mensagem de voz palavra por palavra em português. Apenas retorne a transcrição, sem explicações adicionais.',
        fr: 'Transcrivez ce message vocal mot à mot en français. Retournez uniquement la transcription, sans explications supplémentaires.',
      };

      const prompt = langPrompts[language || 'en'] || langPrompts.en;

      // Call Claude with audio
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'audio',
                source: {
                  type: 'base64',
                  media_type: mediaType as 'audio/ogg' | 'audio/mpeg' | 'audio/wav' | 'audio/webm',
                  data: base64Audio,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
      });

      const transcription = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('\n')
        .trim();

      logger.info({ transcriptionLength: transcription.length }, 'Audio transcription complete');
      return transcription;
    } catch (error) {
      const err = error as Error;
      logger.error({ err, audioUrl }, 'Failed to transcribe audio');
      return '[Voice message received - could not transcribe]';
    }
  }

  /**
   * Analyze image using Claude Vision
   * @param imageUrl URL of the image to analyze
   * @param language Language for the response
   * @param context Optional context about what to look for
   */
  async analyzeImage(imageUrl: string, language: string = 'en', context?: string): Promise<string> {
    try {
      logger.info({ imageUrl, language }, 'Starting image analysis');

      // Download the image
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error(`Failed to download image: ${imageResponse.status}`);
      }

      const imageBuffer = await imageResponse.arrayBuffer();
      const base64Image = Buffer.from(imageBuffer).toString('base64');

      // Determine media type from URL or response headers
      const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
      const mediaType = contentType.includes('png') ? 'image/png'
        : contentType.includes('gif') ? 'image/gif'
        : contentType.includes('webp') ? 'image/webp'
        : 'image/jpeg';

      // Language-specific prompts
      const prompts: Record<string, string> = {
        es: `Analiza esta imagen en el contexto de una conversación de salud.
Describe lo que ves de manera clara y útil para documentar en una nota de salud.
Si es una foto de un síntoma (erupción, hinchazón, etc.), describe su apariencia.
Si es una foto de medicamentos, identifica los nombres y dosis visibles.
Si es una receta o documento médico, extrae la información relevante.
Sé conciso pero informativo. Responde en español.`,
        en: `Analyze this image in the context of a health conversation.
Describe what you see in a way that's useful for documenting in a health note.
If it's a photo of a symptom (rash, swelling, etc.), describe its appearance.
If it's a photo of medications, identify visible names and dosages.
If it's a prescription or medical document, extract relevant information.
Be concise but informative. Respond in English.`,
        pt: `Analise esta imagem no contexto de uma conversa de saúde.
Descreva o que você vê de forma útil para documentar em uma nota de saúde.
Se for uma foto de um sintoma (erupção, inchaço, etc.), descreva sua aparência.
Se for uma foto de medicamentos, identifique os nomes e dosagens visíveis.
Se for uma receita ou documento médico, extraia as informações relevantes.
Seja conciso mas informativo. Responda em português.`,
        fr: `Analysez cette image dans le contexte d'une conversation sur la santé.
Décrivez ce que vous voyez de manière utile pour documenter dans une note de santé.
S'il s'agit d'une photo d'un symptôme (éruption, gonflement, etc.), décrivez son apparence.
S'il s'agit d'une photo de médicaments, identifiez les noms et dosages visibles.
S'il s'agit d'une ordonnance ou d'un document médical, extrayez les informations pertinentes.
Soyez concis mais informatif. Répondez en français.`,
      };

      const systemPrompt = prompts[language] || prompts.en;
      const userPrompt = context
        ? `${context}\n\nPlease analyze the attached image.`
        : 'Please analyze this image and describe what you see.';

      // Call Claude with vision
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929', // Using Sonnet for cost efficiency
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: base64Image,
                },
              },
              {
                type: 'text',
                text: userPrompt,
              },
            ],
          },
        ],
        system: systemPrompt,
      });

      const content = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('\n');

      logger.info({ responseLength: content.length }, 'Image analysis complete');
      return content;
    } catch (error) {
      const err = error as Error;
      logger.error({ err, imageUrl }, 'Failed to analyze image');
      return '[Image received - could not analyze]';
    }
  }
}

// Singleton instance
export const mediaService = new MediaService();
