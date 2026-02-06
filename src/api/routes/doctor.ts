import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { queryOne, db } from '../../infra/db/client';
import { ConcernService } from '../../domain/concern/service';

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
    // Main concern / Motivo (including simple format: "Concern: X", "Motivo: X")
    motivo: [
      /(?:MOTIVO PRINCIPAL|MAIN CONCERN|QUEIXA PRINCIPAL|MOTIF PRINCIPAL)[:\s]*([^\n]+)/i,
      /(?:Main concern|Motivo de consulta|Chief complaint)[:\s]*([^\n]+)/i,
      /^(?:Concern|Motivo|Queixa|Motif)[:\s]*([^\n]+)/im,  // Simple format
    ],
    // Onset / Inicio
    inicio: [
      /(?:INICIO|ONSET|INÍCIO|DÉBUT)[^:]*[:\s]*([^\n]+)/i,
      /(?:Started|Comenzó|Início|Début)[:\s]*([^\n]+)/i,
      /(?:When did (?:it|this) start|Cuándo comenzó)[:\s]*([^\n]+)/i,
      /^(?:Inicio|Started|Início|Début)[:\s]*([^\n]+)/im,  // Simple format
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
      /^(?:Mejora con|Helps|Melhora com|Améliore)[:\s]*([^\n]+)/im,  // Simple format
    ],
    // What worsens / Aggravating factors
    factoresAgravan: [
      /(?:EMPEORA|WORSENS|PIORA|AGGRAVE)[^:]*[:\s]*([^\n]+)/i,
      /(?:Worsens|Empeora|What worsens|Factores que agravan)[:\s]*([^\n]+)/i,
      /(?:Aggravating factors)[:\s]*([^\n]+)/i,
      /^(?:Empeora con|Worsens|Piora com|Aggrave)[:\s]*([^\n]+)/im,  // Simple format
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
      // Skip generic headers and short lines
      return cleaned.length > 3 &&
        !cleaned.match(/^(health\s*note|health\s*summary|resumen|summary|nota\s*de\s*salud|your\s*health|tu\s*nota)/i) &&
        !cleaned.match(/^(concern|motivo|started|inicio|helps|mejora|worsens|empeora)[:\s]/i);  // Skip field labels
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
        const value = cleanHpiValue(match[1]);
        if (value && value.toLowerCase() !== 'no especificado' && value.toLowerCase() !== 'not specified' && value.toLowerCase() !== 'no proporcionado') {
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
      const measures = cleanMedidas(match[1]);
      if (measures.length > 0) {
        note.medidas = measures;
      }
      break;
    }
  }

  // If factoresAlivian has treatments, add to medidas
  if (note.hpi.factoresAlivian && note.medidas.length === 0) {
    const treatments = cleanMedidas(note.hpi.factoresAlivian);
    if (treatments.length > 0) {
      note.medidas = treatments;
    }
  }

  // Extract questions/goals
  for (const pattern of patterns.objetivos) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      const cleanedObjetivos = cleanObjetivos(match[1]);
      if (cleanedObjetivos) {
        note.objetivos = cleanedObjetivos;
      }
      break;
    }
  }

  return note;
}

/**
 * Clean a value for doctor-friendly display
 * Removes conversation artifacts, placeholders, and formats for clinical use
 */
function cleanValue(value: string): string {
  if (!value) return '';

  let cleaned = value
    .trim()
    // Remove conversation prefixes (Usuario reporta → Paciente reports)
    .replace(/^Usuario\s*(reporta|confirma|describe|caracteriza|indica|aclara|proporciona nombre)[\s:]*["']?/gi, '')
    .replace(/^Patient\s*(reports?|confirms?|describes?|indicates?)[\s:]*["']?/gi, '')
    .replace(/^Paciente\s*(reporta|confirma|describe)[\s:]*["']?/gi, '')
    // Remove trailing quotes
    .replace(/["']\s*$/g, '')
    // Remove placeholder values
    .replace(/^no\s*proporcionado$/i, '')
    .replace(/^not\s*provided$/i, '')
    .replace(/^n\/a$/i, '')
    .replace(/^none$/i, '')
    .replace(/^ninguno$/i, '')
    // Remove bullets and formatting
    .replace(/^[\-\•\*\s]+/, '')
    .replace(/[\-\•\*\s]+$/, '')
    .replace(/^\(|\)$/g, '')
    // Clean multiple conversation entries joined together
    .replace(/Usuario\s*(reporta|confirma|describe|caracteriza|indica|aclara)[\s:]*["']?/gi, '. ')
    .replace(/Patient\s*(reports?|confirms?|describes?)[\s:]*["']?/gi, '. ')
    // Clean up artifacts
    .replace(/\.\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();

  // If the result is too short or just punctuation, return empty
  if (cleaned.length < 2 || /^[\.\,\s\-]+$/.test(cleaned)) {
    return '';
  }

  // Capitalize first letter
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  return cleaned;
}

/**
 * Clean content specifically for HPI fields
 * Extracts the actual clinical content from conversation-style text
 */
function cleanHpiValue(value: string): string {
  if (!value) return '';

  // First apply general cleaning
  let cleaned = cleanValue(value);

  // If it still contains conversation patterns, try to extract just the clinical info
  if (cleaned.includes('Usuario') || cleaned.includes('Patient')) {
    // Try to extract quoted content or content after colons
    const quotedMatch = cleaned.match(/["']([^"']+)["']/);
    if (quotedMatch && quotedMatch[1]) {
      cleaned = quotedMatch[1];
    }
  }

  return cleaned;
}

/**
 * Clean medidas (measures) text - extracts actual treatments from conversation text
 */
function cleanMedidas(text: string): string[] {
  if (!text) return [];

  // Split by common delimiters
  const parts = text.split(/[.;\n]/).map(p => cleanValue(p)).filter(p => p.length > 3);

  // Filter out conversation-style entries
  return parts.filter(p => {
    const lower = p.toLowerCase();
    // Skip entries that are just conversation logs
    if (lower.startsWith('usuario') || lower.startsWith('patient') || lower.startsWith('paciente')) {
      return false;
    }
    // Skip placeholder text
    if (lower === 'no proporcionado' || lower === 'not provided' || lower === 'ninguno') {
      return false;
    }
    return true;
  });
}

/**
 * Clean objetivos (questions/goals) - extracts actual questions
 */
function cleanObjetivos(text: string): string {
  if (!text) return '';

  // Split by common delimiters and clean
  const questions = text
    .split(/[\n•\-]/)
    .map(q => cleanValue(q))
    .filter(q => {
      if (q.length < 5) return false;
      const lower = q.toLowerCase();
      // Skip conversation-style entries
      if (lower.startsWith('usuario') || lower.startsWith('patient')) return false;
      // Skip numbered entries that are just placeholders
      if (/^\d+\.?\s*$/.test(q)) return false;
      return true;
    })
    .slice(0, 3);

  return questions.join('. ');
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

    // Fetch per-concern data from health_concerns table (primary source)
    let concerns: Array<{
      id: string;
      title: string;
      status: string;
      summaryContent: string | null;
      icon: string | null;
      updatedAt: Date;
      parsed: DoctorNote;
    }> = [];

    try {
      const concernService = new ConcernService(db);
      const allConcerns = await concernService.getAllConcerns(userId);
      concerns = allConcerns.map(c => ({
        id: c.id,
        title: c.title,
        status: c.status,
        summaryContent: c.summaryContent,
        icon: c.icon,
        updatedAt: c.updatedAt,
        parsed: parseSummaryToDoctorNote(c.summaryContent || '', user.language),
      }));
    } catch {
      // Table may not exist yet — fall through to legacy
    }

    // Parse legacy summary as fallback
    let doctorNote: DoctorNote | null = null;
    let dateLabel = '';
    let updatedAt: Date | null = null;

    if (summary) {
      doctorNote = parseSummaryToDoctorNote(summary.content, user.language);
      dateLabel = formatDateLabel(summary.created_at, user.language);
      updatedAt = summary.created_at;
    } else if (concerns.length === 0) {
      return reply.status(404).send({ error: 'No summary found' });
    }

    // Use the most recent concern's date if available
    if (concerns.length > 0) {
      const newestConcern = concerns[0]!;
      dateLabel = formatDateLabel(newestConcern.updatedAt, user.language);
      updatedAt = newestConcern.updatedAt;
    }

    // Return formatted response with both legacy and per-concern data
    return {
      userId: user.id,
      userName: user.name,
      language: user.language,
      dateLabel,
      updatedAt,
      // Legacy doctor note fields (for backward compat)
      motivo: doctorNote?.motivo || '',
      hpi: doctorNote?.hpi || {},
      sintomasAsociados: doctorNote?.sintomasAsociados || null,
      medidas: doctorNote?.medidas || [],
      objetivos: doctorNote?.objetivos || null,
      // Per-concern data (primary — each concern parsed into clinical format)
      concerns: concerns.map(c => ({
        id: c.id,
        title: c.title,
        status: c.status,
        icon: c.icon,
        updatedAt: c.updatedAt,
        motivo: c.parsed.motivo,
        hpi: c.parsed.hpi,
        sintomasAsociados: c.parsed.sintomasAsociados,
        medidas: c.parsed.medidas,
        objetivos: c.parsed.objetivos,
      })),
    };
  });
};
