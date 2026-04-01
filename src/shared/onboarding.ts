/**
 * Plato Inteligente — Onboarding Questions + Archetype Scoring
 *
 * 5-question onboarding sequence sent one at a time via WhatsApp.
 * After question 5, answers are scored to detect the client's archetype.
 *
 * Archetypes:
 *   performance — self-initiates, wants mechanism, data-driven, fast adopter
 *   skeptic     — past failures, needs proof, slow trust, guarded
 *   curious     — asks WHY, engages but may not act, mechanism-driven
 *   passive     — low initiative, overwhelmed, needs simplicity
 */

import { Archetype, ArchetypeScores, OnboardingAnswer } from './types';

// ============================================================================
// Onboarding Questions (bilingual)
// ============================================================================

export const ONBOARDING_QUESTIONS: Record<string, string[]> = {
  es: [
    '¿Qué te trajo aquí — qué quieres entender mejor de tu cuerpo?',
    '¿Cómo describes tu relación con la comida en este momento?',
    '¿Cuándo fue la última vez que intentaste cambiar algo de tu alimentación — qué pasó?',
    '¿Qué tan seguido haces ejercicio, y cómo te sientes después de entrenar?',
    'Esto funciona así: tú me mandas lo que comes, yo lo analizo y con el tiempo te muestro los patrones de tu cuerpo. ¿Hay algo que quieras que sepa antes de empezar?',
  ],
  en: [
    "What brought you here — what do you want to better understand about your body?",
    "How would you describe your relationship with food right now?",
    "When was the last time you tried to change something about your eating — what happened?",
    "How often do you exercise, and how do you feel after working out?",
    "Here's how this works: you send me what you eat, I analyze it, and over time I show you the patterns in your body. Is there anything you want me to know before we start?",
  ],
};

// Intro message sent before question 1
export const ONBOARDING_INTRO: Record<string, string> = {
  es: 'Hola 👋\nEstoy aquí para ayudarte a entender qué hacer con lo que ya tienes en tu cocina.\n\nAquí no te voy a señalar lo que hiciste mal.\nTampoco te voy a dar una dieta.\nSolo vamos a mirar tu día con calma y entender qué pasó en tu cuerpo.\nSin juicio. Sin presión.\n\nPara conocerte mejor y darte el mejor servicio posible, te voy a hacer unas preguntas cortas. Te las mando una a la vez.\n\nPrimera pregunta:',
  en: "Hello 👋\nI'm here to help you make the most of what you already have in your kitchen.\n\nI'm not going to point out what you did wrong.\nI'm not going to give you a diet.\nWe're just going to look at your day calmly and understand what happened in your body.\nNo judgment. No pressure.\n\nTo get to know you better and give you the best experience, I'll ask you a few short questions. I'll send them one at a time.\n\nFirst question:",
};

// Confirmation sent after question 5 (before archetype-specific message)
export const ONBOARDING_COMPLETE: Record<string, string> = {
  es: 'Perfecto, ya tengo lo que necesito para empezar contigo 🙌\n\nA partir de ahora, mándame lo que comes durante el día — texto, foto, o nota de voz. Yo lo registro y con el tiempo te muestro los patrones.',
  en: "Perfect, I have what I need to get started with you 🙌\n\nFrom now on, send me what you eat during the day — text, photo, or voice note. I'll log it and over time show you the patterns.",
};

// Archetype-specific first impression (sent after onboarding completes)
export const ARCHETYPE_FIRST_IMPRESSION: Record<Archetype, Record<string, string>> = {
  performance: {
    es: 'Veo que te importa entender cómo funciona tu cuerpo — eso es exactamente con lo que trabajo mejor. Te voy a mostrar los datos, tú decides qué hacer con ellos.',
    en: "I can see you care about understanding how your body works — that's exactly what I do best. I'll show you the data, you decide what to do with it.",
  },
  skeptic: {
    es: 'Entiendo que ya has intentado cosas antes. Aquí no te pido que confíes — solo que mandes lo que comes. Con el tiempo los datos hablan solos.',
    en: "I understand you've tried things before. I'm not asking you to trust me — just send what you eat. Over time the data speaks for itself.",
  },
  curious: {
    es: 'Me gustan las preguntas — y tú tienes muchas. Te las voy a responder con tus propios datos, no con teorías. Cada pregunta que me hagas la incluyo en tu análisis.',
    en: "I like questions — and you have plenty. I'll answer them with your own data, not with theories. Every question you ask me gets included in your analysis.",
  },
  passive: {
    es: 'Simple: mándame lo que comes, cuando puedas. No hay formato correcto. No hay cantidad mínima. Yo me encargo del resto.',
    en: "Simple: send me what you eat, whenever you can. No right format. No minimum amount. I'll handle the rest.",
  },
  unknown: {
    es: 'Vamos paso a paso. Mándame lo que comes hoy y empezamos a construir tu mapa.',
    en: "Let's go step by step. Send me what you eat today and we'll start building your map.",
  },
};

// ============================================================================
// Archetype Scoring
// ============================================================================

/**
 * Score a single answer against archetype indicators.
 * Returns a partial score object for each archetype.
 */
function scoreAnswer(questionIndex: number, answer: string): ArchetypeScores {
  const lower = answer.toLowerCase();
  const scores: ArchetypeScores = { performance: 0, skeptic: 0, curious: 0, passive: 0 };

  if (questionIndex === 0) {
    // Q1: What brought you here / what do you want to understand
    if (/energía|energy|rendimiento|performance|gym|entreno|workout|músculo|muscle|optimizar|optimize/.test(lower)) scores.performance += 2;
    if (/por qué|why|cómo funciona|how does|mecanismo|mechanism|entender|understand|curiosi/.test(lower)) scores.curious += 2;
    if (/intenté|tried|fallé|failed|no me funcionó|didn't work|escéptico|skeptic|duda|doubt/.test(lower)) scores.skeptic += 2;
    if (/no sé|don't know|alguien me dijo|someone told me|me mandaron|they sent me|no tengo idea/.test(lower)) scores.passive += 2;
  }

  if (questionIndex === 1) {
    // Q2: Relationship with food right now
    if (/control|disciplina|discipline|estructura|structure|seguimiento|tracking|mido|measure/.test(lower)) scores.performance += 2;
    if (/complicada|complicated|difícil|difficult|confusa|confused|no entiendo|don't understand/.test(lower)) scores.curious += 1;
    if (/mala|bad|culpa|guilty|vergüenza|shame|fallé|failed|siempre fallo|always fail/.test(lower)) scores.skeptic += 2;
    if (/normal|igual|así nomás|okay i guess|no pienso|don't think about|como lo que hay|eat what's there/.test(lower)) scores.passive += 2;
    if (/interesante|interesting|fascinante|fascinating|quiero aprender|want to learn/.test(lower)) scores.curious += 2;
  }

  if (questionIndex === 2) {
    // Q3: Last time tried to change eating — what happened
    if (/funcionó|worked|logré|achieved|mejoró|improved|bien|well/.test(lower)) scores.performance += 1;
    if (/no funcionó|didn't work|dejé|quit|rendí|gave up|difícil|hard|fracasé|failed/.test(lower)) scores.skeptic += 2;
    if (/aprendí|learned|descubrí|discovered|interesante|interesting|me di cuenta|realized/.test(lower)) scores.curious += 2;
    if (/nunca|never|no recuerdo|don't remember|hace mucho|long time ago|no he intentado|haven't tried/.test(lower)) scores.passive += 2;
    if (/experimento|experiment|probé|tried|variante|variant|sistema|system/.test(lower)) scores.performance += 2;
  }

  if (questionIndex === 3) {
    // Q4: Exercise frequency + how you feel after
    if (/todos los días|every day|diario|daily|gym|5 veces|6 veces|5 times|6 times|entreno regular|regular training/.test(lower)) scores.performance += 2;
    if (/a veces|sometimes|cuando puedo|when i can|irregular|no mucho|not much/.test(lower)) scores.passive += 1;
    if (/nunca|never|no hago|don't exercise|no puedo|can't/.test(lower)) scores.passive += 2;
    if (/siento que|i feel like|noto que|i notice|me pregunto|i wonder/.test(lower)) scores.curious += 1;
    if (/energía|energy|rendimiento|performance|recuperación|recovery|músculo|muscle/.test(lower)) scores.performance += 1;
  }

  if (questionIndex === 4) {
    // Q5: Anything you want me to know before starting
    if (/nada|nothing|no|todo bien|all good/.test(lower) && answer.length < 30) scores.passive += 1;
    if (/privacidad|privacy|datos|data|cómo funciona|how does this work|seguro|safe/.test(lower)) scores.skeptic += 2;
    if (/pregunta|question|duda|doubt|quiero saber|want to know|explícame|explain/.test(lower)) scores.curious += 2;
    if (/objetivo|goal|meta|target|quiero lograr|want to achieve|plan/.test(lower)) scores.performance += 2;
    if (/tiempo|time|cuánto tarda|how long|resultados|results/.test(lower)) {
      // Could be skeptic or performance
      scores.skeptic += 1;
      scores.performance += 1;
    }
  }

  return scores;
}

/**
 * Derive the final archetype from accumulated scores across all 5 answers.
 */
export function detectArchetype(answers: OnboardingAnswer[]): {
  archetype: Archetype;
  scores: ArchetypeScores;
} {
  const total: ArchetypeScores = { performance: 0, skeptic: 0, curious: 0, passive: 0 };

  for (const { question, answer } of answers) {
    const partial = scoreAnswer(question - 1, answer);
    total.performance += partial.performance;
    total.skeptic += partial.skeptic;
    total.curious += partial.curious;
    total.passive += partial.passive;
  }

  // Find the highest scoring archetype
  const entries = Object.entries(total) as [Archetype, number][];
  const sorted = entries.sort((a, b) => b[1] - a[1]);
  const topScore = sorted[0]![1];

  // If all scores are 0 or tied at low values, default to unknown
  if (topScore === 0) {
    return { archetype: 'unknown', scores: total };
  }

  return { archetype: sorted[0]![0], scores: total };
}

/**
 * Get the question text for a given step (1-5) and language.
 */
export function getQuestion(step: number, language: string): string {
  const lang = language in ONBOARDING_QUESTIONS ? language : 'es';
  const questions = ONBOARDING_QUESTIONS[lang]!;
  return questions[step - 1] ?? questions[0]!;
}

/**
 * Get the intro message (sent before Q1) in the right language.
 */
export function getOnboardingIntro(language: string): string {
  const lang = language in ONBOARDING_INTRO ? language : 'es';
  return ONBOARDING_INTRO[lang]!;
}

/**
 * Get the completion message (sent after Q5, before archetype message) in the right language.
 */
export function getOnboardingComplete(language: string): string {
  const lang = language in ONBOARDING_COMPLETE ? language : 'es';
  return ONBOARDING_COMPLETE[lang]!;
}

/**
 * Get the archetype-specific first impression message.
 */
export function getArchetypeMessage(archetype: Archetype, language: string): string {
  const lang = language in ONBOARDING_COMPLETE ? language : 'es';
  return ARCHETYPE_FIRST_IMPRESSION[archetype][lang]!;
}
