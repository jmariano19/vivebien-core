import { Message } from './types';

/**
 * Detect the language of a message based on common word patterns.
 * Returns 'es', 'en', 'pt', 'fr' or null if uncertain.
 */
export function detectLanguage(message: string): 'es' | 'en' | 'pt' | 'fr' | null {
  const lower = message.toLowerCase();

  const countMatches = (words: string[]): number => {
    return words.filter(word => new RegExp(`\\b${word}\\b`, 'i').test(lower)).length;
  };

  const ptWords = ['você', 'voce', 'oi', 'olá', 'ola', 'obrigado', 'obrigada', 'tudo', 'bem', 'estou', 'tenho', 'não', 'nao', 'meu', 'minha', 'como', 'está', 'bom', 'dia', 'boa', 'tarde', 'noite', 'por', 'favor', 'dor', 'ontem', 'hoje', 'semana', 'muito', 'quando', 'mais', 'mas', 'também', 'tambem', 'depois', 'ainda', 'agora', 'então', 'entao', 'pode', 'uma', 'ele', 'ela', 'dos', 'das', 'piora', 'melhora', 'cabeça', 'cabeca', 'forte', 'tempo', 'sempre', 'melhor', 'pior'];
  const ptScore = countMatches(ptWords) + (lower.match(/ção\b|ões\b/g)?.length || 0);

  const esWords = ['hola', 'estoy', 'tengo', 'cómo', 'como', 'estás', 'buenos', 'días', 'buenas', 'tardes', 'gracias', 'qué', 'que', 'cuál', 'cual', 'cuándo', 'cuando', 'dónde', 'donde', 'dolor', 'ayer', 'hoy', 'semana', 'muy', 'pero', 'también', 'tambien', 'después', 'despues', 'ahora', 'todavía', 'todavia', 'puede', 'una', 'las', 'los', 'del', 'mucho', 'poco', 'cabeza', 'empeora', 'mejora', 'fuerte', 'siempre', 'mejor', 'peor', 'con', 'sin', 'desde'];
  const esScore = countMatches(esWords) + (lower.match(/ción\b/g)?.length || 0);

  const enWords = ['hello', 'hi', 'hey', 'am', 'have', 'has', 'had', 'the', 'an', 'my', 'is', 'are', 'was', 'were', 'what', 'when', 'where', 'why', 'how', 'please', 'thank', 'thanks', 'yes', 'not', 'it', 'this', 'that', 'with', 'and', 'but', 'eye', 'pain', 'day', 'days', 'week', 'yesterday', 'today', 'started', 'feeling', 'feel', 'headache', 'worse', 'better', 'doctor', 'medicine', 'because', 'since', 'been', 'about', 'does', 'much', 'also', 'still', 'just', 'very', 'really', 'sometimes', 'always', 'never'];
  const enScore = countMatches(enWords) + (lower.match(/ing\b/g)?.length || 0);

  const frWords = ['bonjour', 'salut', 'je', 'suis', 'ai', 'comment', 'merci', 'oui', 'non', 'le', 'la', 'les', 'mon', 'ma', 'mes', 'que', 'qui', 'où', 'douleur', 'hier', 'aujourd', 'semaine', 'avec', 'pour', 'dans', 'aussi', 'après', 'apres', 'encore', 'toujours', 'jamais', 'maintenant', 'peut', 'beaucoup', 'très', 'tres', 'depuis', 'tête', 'tete', 'pire', 'mieux', 'médecin', 'medecin'];
  const frScore = countMatches(frWords);

  const scores = [
    { lang: 'pt' as const, score: ptScore },
    { lang: 'es' as const, score: esScore },
    { lang: 'en' as const, score: enScore },
    { lang: 'fr' as const, score: frScore },
  ].sort((a, b) => b.score - a.score);

  const first = scores[0]!;
  const second = scores[1]!;

  // If only one language matches at all (no competition), score of 1 is sufficient
  // e.g., "Hello" → EN=1, all others=0 → clearly English
  if (first.score >= 1 && second.score === 0) {
    return first.lang;
  }

  if (first.score >= 2 && first.score > second.score) {
    return first.lang;
  }

  if (first.score >= 3 && first.score === second.score && (first.lang === 'en' || second.lang === 'en')) {
    return 'en';
  }

  return null;
}

/**
 * Extract user name from message text, checking both proactive patterns
 * ("je m'appelle Marie") and responses to AI name-ask questions.
 */
export function extractUserName(userMessage: string, recentMessages: Message[]): string | null {
  const lastAssistantMessage = recentMessages
    .slice()
    .reverse()
    .find(m => m.role === 'assistant');

  const nameRequestPatterns = [
    /cómo te gustaría que te llame/i,
    /cómo te llamas/i,
    /cuál es tu nombre/i,
    /what would you like me to call you/i,
    /what name would you like me to use/i,
    /what name should i use/i,
    /what's your name/i,
    /what is your name/i,
    /como (?:você )?gostaria que eu te chamasse/i,
    /qual é o seu nome/i,
    /comment aimeriez-vous que je vous appelle/i,
    /quel (?:est votre )?nom aimeriez-vous/i,
    /quel est votre nom/i,
  ];

  const askedForName = lastAssistantMessage && nameRequestPatterns.some(pattern =>
    pattern.test(lastAssistantMessage.content)
  );

  const proactiveNamePatterns = [
    /\b(mi nombre es|me llamo|soy)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)/i,
    /\b(my name is|i'm|i am)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)/i,
    /\b(meu nome é|me chamo)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)/i,
    /\b(je m'appelle|je suis)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)/i,
  ];

  const notNameWords = [
    'doing', 'feeling', 'good', 'well', 'fine', 'ok', 'okay', 'great', 'bad',
    'sick', 'ill', 'tired', 'better', 'worse', 'not', 'very', 'so', 'really',
    'having', 'experiencing', 'getting', 'going', 'looking', 'trying',
    'here', 'back', 'new', 'just', 'also', 'still', 'now', 'happy', 'sad',
    'bien', 'mal', 'enfermo', 'enferma', 'cansado', 'cansada', 'mejor', 'peor',
    'aquí', 'aqui', 'nuevo', 'nueva', 'preocupado', 'preocupada',
    'bem', 'doente', 'cansado', 'melhor', 'pior',
    'malade', 'fatigué', 'fatiguée', 'mieux', 'pire',
    'très', 'tres',
  ];

  for (const pattern of proactiveNamePatterns) {
    const match = userMessage.match(pattern);
    if (match && match[2]) {
      const extractedName = match[2].trim();
      const firstWord = extractedName.split(/\s+/)[0]?.toLowerCase();

      if (firstWord && notNameWords.includes(firstWord)) {
        continue;
      }

      const words = extractedName.split(/\s+/);
      if (words.length >= 1 && words.length <= 4) {
        const isValidName = words.every(word => /^[\p{L}]{2,20}$/u.test(word));
        if (isValidName) {
          return words
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
        }
      }
    }
  }

  if (!askedForName) {
    return null;
  }

  const declinePatterns = [
    /\bno\s*(,|\.|\s|$)/i,
    /\bskip\b/i,
    /\bomitir\b/i,
    /prefiero no\b/i,
    /\bno (quiero|deseo)/i,
    /\bpular\b/i,
    /\bignorer\b/i,
    /prefer not\b/i,
  ];

  if (declinePatterns.some(pattern => pattern.test(userMessage))) {
    return null;
  }

  const cleaned = userMessage
    .trim()
    .replace(/^(me llamo|soy|mi nombre es|my name is|i'm|i am|je suis|je m'appelle|meu nome é|me chamo)\s+/i, '')
    .replace(/[.,!?¿¡]+$/g, '')
    .trim();

  const words = cleaned.split(/\s+/);
  if (words.length < 1 || words.length > 4) {
    return null;
  }

  const isValidName = words.every(word => /^[\p{L}]{2,20}$/u.test(word));
  if (!isValidName) {
    return null;
  }

  return words
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Backup name extraction from AI response acknowledgments.
 * e.g. "Merci Marie, c'est très utile" → "Marie"
 */
export function extractNameFromAIResponse(aiResponse: string): string | null {
  const patterns = [
    /^(?:gracias|muchas gracias),\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)\b[.!,\n]/i,
    /^(?:thank you|thanks),\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)\b[.!,\n]/i,
    /^(?:obrigado|obrigada),\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)\b[.!,\n]/i,
    /^(?:merci),\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)\b[.!,\n]/i,
  ];

  for (const pattern of patterns) {
    const match = aiResponse.match(pattern);
    if (match && match[1]) {
      const candidate = match[1].trim();
      const words = candidate.split(/\s+/);

      if (words.length >= 1 && words.length <= 3 &&
          words.every(w => /^[\p{L}]{2,20}$/u.test(w))) {
        return words
          .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ');
      }
    }
  }

  return null;
}
