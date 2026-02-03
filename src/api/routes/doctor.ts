import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { queryOne } from '../../infra/db/client';

/**
 * Doctor Note Data Structure
 * Transforms health summary into clinically-formatted doctor note
 */
interface DoctorNote {
  motivo: string;
  hpi: {
    inicio?: string;
    duracion?: string;
    localizacion?: string;
    caracteristicas?: string;
    evolucion?: string;
    factoresAlivian?: string;
    factoresAgravan?: string;
  };
  sintomasAsociados: string | null;
  medidas: string[];
  objetivos: string | null;
}

/**
 * Parse health summary content into structured doctor note
 * Handles multiple formats (structured headers, WhatsApp format, free text)
 */
function parseSummaryToDoctorNote(content: string, language: string): DoctorNote {
  const note: DoctorNote = {
    motivo: '',
    hpi: {},
    sintomasAsociados: null,
    medidas: [],
    objetivos: null,
  };

  if (!content) return note;

  // Normalize content - remove WhatsApp formatting
  let normalized = content
    .replace(/\*\*/g, '')           // Remove markdown bold
    .replace(/\*([^*]+)\*/g, '$1')  // Remove WhatsApp bold
    .replace(/_([^_]+)_/g, '$1')    // Remove WhatsApp italic
    .replace(/📝|❓|•/g, '')        // Remove emojis and bullets
    .replace(/---+/g, '\n')         // Convert separators to newlines
    .trim();

  // Multi-language header patterns
  const patterns = {
    // Main concern / Motivo
    motivo: [
      /(?:MOTIVO PRINCIPAL|MAIN CONCERN|QUEIXA PRINCIPAL|MOTIF PRINCIPAL)[:\s]*([^\n]+)/i,
      /(?:Main concern|Motivo de consulta|Chief complaint)[:\s]*([^\n]+)/i,
    ],
    // Onset / Inicio
    inicio: [
      /(?:INICIO|ONSET|INÍCIO|DÉBUT)[^:]*[:\s]*([^\n]+)/i,
      /(?:Started|Comenzó|Início|Début)[:\s]*([^\n]+)/i,
      /(?:When did (?:it|this) start|Cuándo comenzó)[:\s]*([^\n]+)/i,
    ],
    // Duration / Duración
    duracion: [
      /(?:DURACIÓN|DURATION|DURAÇÃO|DURÉE)[:\s]*([^\n]+)/i,
      /(?:Duration|Duración)[:\s]*([^\n]+)/i,
    ],
    // Location / Localización
    localizacion: [
      /(?:LOCALIZACIÓN|LOCATION|LOCALIZAÇÃO|LOCALISATION)[:\s]*([^\n]+)/i,
      /(?:Location|Ubicación|Where)[:\s]*([^\n]+)/i,
    ],
    // Pattern / Characteristics
    caracteristicas: [
      /(?:PATRÓN|PATTERN|PADRÃO|SCHÉMA)[^:]*[:\s]*([^\n]+)/i,
      /(?:Characteristics|Características|Pattern|Severity)[:\s]*([^\n]+)/i,
      /(?:Current symptoms|Síntomas actuales)[:\s]*([^\n]+)/i,
    ],
    // What helps / Relieving factors
    factoresAlivian: [
      /(?:QUÉ AYUDA|WHAT HELPS|O QUE AJUDA|CE QUI AIDE)[^:]*[:\s]*([^\n]+)/i,
      /(?:Helps|Ayuda|What helps|Factores que alivian)[:\s]*([^\n]+)/i,
      /(?:Relieving factors)[:\s]*([^\n]+)/i,
    ],
    // What worsens / Aggravating factors
    factoresAgravan: [
      /(?:EMPEORA|WORSENS|PIORA|AGGRAVE)[^:]*[:\s]*([^\n]+)/i,
      /(?:Worsens|Empeora|What worsens|Factores que agravan)[:\s]*([^\n]+)/i,
      /(?:Aggravating factors)[:\s]*([^\n]+)/i,
    ],
    // Associated symptoms
    sintomasAsociados: [
      /(?:SÍNTOMAS ASOCIADOS|ASSOCIATED SYMPTOMS|SINTOMAS ASSOCIADOS|SYMPTÔMES ASSOCIÉS)[:\s]*([^\n]+)/i,
    ],
    // Measures / Treatments
    medidas: [
      /(?:MEDICAMENTOS|MEDICATIONS|MEDICAMENTOS ATUAIS|MÉDICAMENTS)[^:]*[:\s]*([^\n]+(?:\n[^A-Z\n][^\n]*)*)/i,
      /(?:What helps|Qué ayuda)[:\s]*([^\n]+)/i,
    ],
    // Questions / Goals
    objetivos: [
      /(?:PREGUNTAS PARA|QUESTIONS FOR|PERGUNTAS PARA|QUESTIONS POUR)[^:]*[:\s]*([\s\S]*?)(?=\n\n|$)/i,
      /(?:Questions for your visit|Preguntas para tu visita)[:\s]*([\s\S]*?)(?=\n\n|$)/i,
    ],
  };

  // Extract motivo (main concern)
  for (const pattern of patterns.motivo) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      note.motivo = cleanValue(match[1]);
      break;
    }
  }

  // If no structured motivo found, try to extract from first meaningful line
  if (!note.motivo) {
    const firstLine = normalized.split('\n').find(line => {
      const cleaned = line.trim();
      return cleaned.length > 10 && !cleaned.match(/^(health summary|resumen|summary)/i);
    });
    if (firstLine) {
      note.motivo = cleanValue(firstLine);
    }
  }

  // Extract HPI fields
  const hpiFields: Array<keyof typeof patterns> = ['inicio', 'duracion', 'localizacion', 'caracteristicas', 'factoresAlivian', 'factoresAgravan'];
  for (const field of hpiFields) {
    for (const pattern of patterns[field]) {
      const match = normalized.match(pattern);
      if (match && match[1]) {
        const value = cleanValue(match[1]);
        if (value && value.toLowerCase() !== 'no especificado' && value.toLowerCase() !== 'not specified') {
          (note.hpi as Record<string, string>)[field] = value;
        }
        break;
      }
    }
  }

  // Extract associated symptoms
  for (const pattern of patterns.sintomasAsociados) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      const value = cleanValue(match[1]);
      if (value && value.toLowerCase() !== 'no reportados' && value.toLowerCase() !== 'none reported') {
        note.sintomasAsociados = value;
      }
      break;
    }
  }

  // Extract measures/medications
  for (const pattern of patterns.medidas) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      const measures = match[1]
        .split(/[\n•\-]/)
        .map(m => cleanValue(m))
        .filter(m => m && m.length > 3);
      if (measures.length > 0) {
        note.medidas = measures;
      }
      break;
    }
  }

  // If factoresAlivian has treatments, add to medidas
  if (note.hpi.factoresAlivian && note.medidas.length === 0) {
    const treatments = note.hpi.factoresAlivian
      .split(/[,;]/)
      .map(t => cleanValue(t))
      .filter(t => t && t.length > 3);
    if (treatments.length > 0) {
      note.medidas = treatments;
    }
  }

  // Extract questions/goals
  for (const pattern of patterns.objetivos) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      const questions = match[1]
        .split(/[\n•\-]/)
        .map(q => cleanValue(q))
        .filter(q => q && q.length > 5 && !q.match(/^\d+\.?\s*$/))
        .slice(0, 3);
      if (questions.length > 0) {
        note.objetivos = questions.join(' ');
      }
      break;
    }
  }

  return note;
}

/**
 * Clean a value - trim, remove trailing punctuation artifacts
 */
function cleanValue(value: string): string {
  return value
    .trim()
    .replace(/^[\-\•\*\s]+/, '')   // Remove leading bullets
    .replace(/[\-\•\*\s]+$/, '')    // Remove trailing bullets
    .replace(/^\(|\)$/g, '')        // Remove wrapping parentheses
    .trim();
}

/**
 * Format date for display based on language
 */
function formatDateLabel(date: Date, language: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  };

  const localeMap: Record<string, string> = {
    es: 'es-ES',
    en: 'en-US',
    pt: 'pt-BR',
    fr: 'fr-FR',
  };

  const locale = localeMap[language] || 'es-ES';
  const formatted = date.toLocaleDateString(locale, options);

  const todayLabels: Record<string, string> = {
    es: 'Hoy',
    en: 'Today',
    pt: 'Hoje',
    fr: "Aujourd'hui",
  };

  const today = todayLabels[language] || 'Hoy';
  return `${today}, ${formatted}`;
}

export const doctorRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  /**
   * Get doctor note by user ID
   * Transforms health summary into clinically-formatted doctor note
   * URL: /api/doctor/:userId
   */
  app.get('/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      return reply.status(404).send({ error: 'Invalid user ID format' });
    }

    // Get user
    const user = await queryOne<{
      id: string;
      phone: string;
      language: string;
      name: string | null;
    }>(
      `SELECT id, phone, COALESCE(language, 'es') as language, name
       FROM users
       WHERE id = $1`,
      [userId]
    );

    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    // Get health summary from memories table
    let summary = null;
    try {
      summary = await queryOne<{
        content: string;
        created_at: Date;
      }>(
        `SELECT content, created_at
         FROM memories
         WHERE user_id = $1 AND category = 'health_summary'
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
    } catch (err) {
      // Table may not exist yet
    }

    if (!summary) {
      return reply.status(404).send({ error: 'No summary found' });
    }

    // Parse summary into doctor note structure
    const doctorNote = parseSummaryToDoctorNote(summary.content, user.language);

    // Return formatted response
    return {
      userId: user.id,
      userName: user.name,
      language: user.language,
      dateLabel: formatDateLabel(summary.created_at, user.language),
      updatedAt: summary.created_at,
      // Doctor note fields (flat for easy consumption)
      motivo: doctorNote.motivo,
      hpi: doctorNote.hpi,
      sintomasAsociados: doctorNote.sintomasAsociados,
      medidas: doctorNote.medidas,
      objetivos: doctorNote.objetivos,
    };
  });
};
