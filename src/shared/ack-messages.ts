/**
 * Plato Inteligente — Ack Message Templates
 *
 * Short, warm acknowledgments sent when a user submits health data.
 * No AI needed — just template strings picked at random.
 * Two types: INPUT acks (food, symptoms, labs) and QUESTION acks.
 */

const INPUT_ACKS: Record<string, string[]> = {
  es: [
    'Anotado \ud83d\udccb',
    'Lo tengo. Va para tu resumen de esta noche.',
    'Recibido \u2713 Lo incluyo en tu an\u00e1lisis de hoy.',
    'Guardado. Esta noche lo hacemos visible.',
  ],
  en: [
    'Got it \ud83d\udccb',
    "Noted. It'll be in your summary tonight.",
    'Received \u2713 Adding it to today\'s analysis.',
    "Saved. We'll make sense of it tonight.",
  ],
  pt: [
    'Anotado \ud83d\udccb',
    'Recebi. Vai pro seu resumo de hoje \u00e0 noite.',
    'Guardado \u2713 Incluo na sua an\u00e1lise de hoje.',
    'Salvo. Hoje \u00e0 noite fazemos vis\u00edvel.',
  ],
  fr: [
    'Not\u00e9 \ud83d\udccb',
    'Re\u00e7u. \u00c7a sera dans votre r\u00e9sum\u00e9 ce soir.',
    'Enregistr\u00e9 \u2713 Je l\'inclus dans votre analyse.',
    'Gard\u00e9. Ce soir on le rend visible.',
  ],
};

const QUESTION_ACKS: Record<string, string[]> = {
  es: [
    'Buena pregunta \ud83d\udc40 Te la respondo en tu resumen de esta noche.',
    'Me la apunto. Esta noche te doy la respuesta con contexto.',
    'Esa me la llevo para tu an\u00e1lisis de hoy. Te respondo esta noche.',
  ],
  en: [
    "Good question \ud83d\udc40 I'll answer it in your summary tonight.",
    "Noted that one. Tonight's summary will have your answer.",
    "Taking that in. You'll get the answer with full context tonight.",
  ],
  pt: [
    'Boa pergunta \ud83d\udc40 Respondo no seu resumo de hoje \u00e0 noite.',
    'Anotei. Hoje \u00e0 noite te dou a resposta com contexto.',
  ],
  fr: [
    'Bonne question \ud83d\udc40 Je vous r\u00e9ponds dans votre r\u00e9sum\u00e9 ce soir.',
    'Not\u00e9e. Ce soir vous aurez la r\u00e9ponse avec contexte.',
  ],
};

/**
 * Question detection keywords by language.
 * If the message starts with any of these (case-insensitive), it's a question.
 */
const QUESTION_STARTERS: Record<string, string[]> = {
  es: ['qu\u00e9', 'que', 'c\u00f3mo', 'como', 'por qu\u00e9', 'por que', 'cu\u00e1ndo', 'cuando', 'd\u00f3nde', 'donde', 'cu\u00e1l', 'cual', 'cu\u00e1nto', 'cuanto', 'puedo', 'debo', 'es bueno', 'es malo', 'se puede'],
  en: ['what', 'how', 'why', 'when', 'where', 'which', 'can', 'should', 'is it', 'do i', 'does', 'will', 'could', 'would'],
  pt: ['que', 'como', 'por que', 'quando', 'onde', 'qual', 'posso', 'devo'],
  fr: ['que', 'comment', 'pourquoi', 'quand', 'o\u00f9', 'ou', 'quel', 'quelle', 'est-ce', 'puis-je'],
};

/**
 * Detect if a message is a question.
 * Uses: (1) contains "?" or (2) starts with question words in any language.
 */
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

/**
 * Pick a random ack message for the given language and message type.
 */
export function getAckMessage(language: string, isQuestionMsg: boolean): string {
  const lang = language in INPUT_ACKS ? language : 'es';
  const pool = isQuestionMsg
    ? (QUESTION_ACKS[lang] || QUESTION_ACKS.es!)
    : (INPUT_ACKS[lang] || INPUT_ACKS.es!);

  return pool[Math.floor(Math.random() * pool.length)]!;
}
