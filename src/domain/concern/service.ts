import { Pool } from 'pg';
import { logger } from '../../infra/logging/logger';

export type ConcernStatus = 'active' | 'improving' | 'resolved';
export type ChangeType = 'auto_update' | 'user_edit' | 'status_change';

export interface HealthConcern {
  id: string;
  userId: string;
  title: string;
  status: ConcernStatus;
  summaryContent: string | null;
  icon: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConcernSnapshot {
  id: string;
  concernId: string;
  userId: string;
  content: string;
  changeType: ChangeType;
  status: string | null;
  createdAt: Date;
}

export class ConcernService {
  constructor(private db: Pool) {}

  /**
   * Get all active (non-resolved) concerns for a user
   */
  async getActiveConcerns(userId: string): Promise<HealthConcern[]> {
    const result = await this.db.query<{
      id: string;
      user_id: string;
      title: string;
      status: ConcernStatus;
      summary_content: string | null;
      icon: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, user_id, title, status, summary_content, icon, created_at, updated_at
       FROM health_concerns
       WHERE user_id = $1 AND status != 'resolved'
       ORDER BY updated_at DESC`,
      [userId]
    );

    return result.rows.map(this.mapRow);
  }

  /**
   * Get ALL concerns for a user (including resolved) — for history page
   */
  async getAllConcerns(userId: string): Promise<HealthConcern[]> {
    const result = await this.db.query<{
      id: string;
      user_id: string;
      title: string;
      status: ConcernStatus;
      summary_content: string | null;
      icon: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, user_id, title, status, summary_content, icon, created_at, updated_at
       FROM health_concerns
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [userId]
    );

    return result.rows.map(this.mapRow);
  }

  /**
   * Get a single concern by ID
   */
  async getConcernById(concernId: string): Promise<HealthConcern | null> {
    const result = await this.db.query<{
      id: string;
      user_id: string;
      title: string;
      status: ConcernStatus;
      summary_content: string | null;
      icon: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, user_id, title, status, summary_content, icon, created_at, updated_at
       FROM health_concerns
       WHERE id = $1`,
      [concernId]
    );

    const row = result.rows[0];
    return row ? this.mapRow(row) : null;
  }

  /**
   * Fuzzy-match an existing concern or create a new one.
   * Matching is case-insensitive substring match on active concerns.
   */
  async getOrCreateConcern(userId: string, title: string, icon?: string): Promise<HealthConcern> {
    // Try to find a matching active concern
    const activeConcerns = await this.getActiveConcerns(userId);
    const normalizedTitle = title.toLowerCase().trim();

    for (const concern of activeConcerns) {
      const existingTitle = concern.title.toLowerCase().trim();

      // Exact match
      if (existingTitle === normalizedTitle) {
        return concern;
      }

      // Substring match (either direction)
      if (existingTitle.includes(normalizedTitle) || normalizedTitle.includes(existingTitle)) {
        // Rename if the new title is different (language change)
        if (concern.title !== title) {
          await this.renameConcern(concern.id, title);
          concern.title = title;
        }
        return concern;
      }

      // Health synonym match — treats related medical terms as the same concern
      if (this.areHealthSynonyms(existingTitle, normalizedTitle)) {
        // Rename to user's current language title
        if (concern.title !== title) {
          await this.renameConcern(concern.id, title);
          concern.title = title;
        }
        return concern;
      }

      // Condition-symptom match — a symptom discussed in the context of a broader condition
      // belongs to that condition (e.g., "Cough" belongs to "Flu")
      if (this.isSymptomOfCondition(existingTitle, normalizedTitle) ||
          this.isSymptomOfCondition(normalizedTitle, existingTitle)) {
        return concern;
      }

      // Word overlap check — if any content word matches, consider it the same concern
      const stopWords = new Set(['with', 'and', 'the', 'in', 'on', 'of', 'con', 'de', 'en', 'el', 'la', 'los', 'las', 'del', 'por', 'y', 'e', 'com', 'do', 'da', 'no', 'na', 'et', 'le', 'les', 'des', 'du']);
      const existingWords = new Set(existingTitle.split(/\s+/).filter(w => !stopWords.has(w)));
      const newWords = normalizedTitle.split(/\s+/).filter(w => !stopWords.has(w));
      const overlap = newWords.filter(w => existingWords.has(w)).length;
      if (overlap > 0) {
        return concern;
      }
    }

    // No match found — create new concern
    return this.createConcern(userId, title, icon);
  }

  /**
   * Check if one title is a symptom commonly associated with a broader condition.
   * E.g., "cough" is a symptom of "flu", "nausea" is a symptom of "food poisoning"
   */
  private isSymptomOfCondition(condition: string, symptom: string): boolean {
    const conditionSymptomMap: Record<string, string[]> = {
      // Flu / Cold / COVID
      'flu': ['cough', 'fever', 'headache', 'body aches', 'fatigue', 'sore throat', 'congestion', 'runny nose', 'chills'],
      'gripe': ['tos', 'fiebre', 'dolor de cabeza', 'dolor corporal', 'fatiga', 'dolor de garganta', 'congestión', 'escalofríos'],
      'cold': ['cough', 'congestion', 'runny nose', 'sore throat', 'sneezing', 'fever'],
      'resfriado': ['tos', 'congestión', 'dolor de garganta', 'estornudos', 'fiebre'],
      'covid': ['cough', 'fever', 'fatigue', 'headache', 'sore throat', 'congestion', 'body aches', 'loss of taste', 'loss of smell'],
      // GI conditions
      'food poisoning': ['nausea', 'vomiting', 'diarrhea', 'stomach pain', 'fever', 'cramps'],
      'intoxicación': ['náusea', 'vómito', 'diarrea', 'dolor de estómago', 'fiebre', 'calambres'],
      'stomach flu': ['nausea', 'vomiting', 'diarrhea', 'fever', 'cramps'],
      // Allergies
      'allergies': ['sneezing', 'congestion', 'itchy eyes', 'runny nose', 'cough', 'rash'],
      'alergias': ['estornudos', 'congestión', 'ojos irritados', 'tos', 'sarpullido'],
    };

    const conditionLower = condition.toLowerCase();
    const symptomLower = symptom.toLowerCase();

    for (const [conditionKey, symptoms] of Object.entries(conditionSymptomMap)) {
      if (conditionLower.includes(conditionKey)) {
        if (symptoms.some(s => symptomLower.includes(s) || s.includes(symptomLower))) {
          return true;
        }
      }
    }

    return false;
  }

  private areHealthSynonyms(a: string, b: string): boolean {
    // Groups of words that refer to the same body system / condition
    const synonymGroups = [
      ['headache', 'headaches', 'migraine', 'migraines', 'head pain', 'dolor de cabeza', 'dolores de cabeza', 'migraña', 'migrañas', 'jaqueca', 'cefalea', 'dor de cabeça', 'enxaqueca', 'mal de tête', 'migraine', 'céphalée'],
      ['back pain', 'backache', 'back ache', 'spine', 'lumbar', 'dolor de espalda', 'lumbago', 'dolor lumbar', 'dor nas costas', 'lombalgia', 'mal de dos'],
      ['stomach', 'stomachache', 'belly', 'abdomen', 'abdominal', 'nausea', 'estómago', 'dolor de estómago', 'barriga', 'estômago', 'dor de estômago', 'mal au ventre'],
      ['knee', 'rodilla', 'joelho', 'genou'],
      ['shoulder', 'hombro', 'ombro', 'épaule'],
      ['neck', 'cuello', 'pescoço', 'cou', 'cervical'],
      ['anxiety', 'anxious', 'ansiedad', 'ansioso', 'ansiedade', 'anxiété'],
      ['insomnia', 'sleep', 'insomnio', 'sueño', 'dormir', 'insônia', 'sommeil'],
      ['cough', 'tos', 'tosse', 'toux'],
      ['flu', 'influenza', 'cold', 'gripe', 'resfriado', 'resfrío', 'grippe', 'rhume'],
      ['fever', 'fiebre', 'febre', 'fièvre'],
      ['chest', 'pecho', 'peito', 'poitrine'],
      ['throat', 'sore throat', 'garganta', 'dolor de garganta', 'dor de garganta', 'mal de gorge'],
      ['skin', 'rash', 'piel', 'sarpullido', 'erupción', 'pele', 'erupção', 'peau', 'éruption'],
      ['eye', 'eyes', 'vision', 'ojo', 'ojos', 'olho', 'olhos', 'œil', 'yeux'],
      ['ear', 'ears', 'oído', 'oreja', 'ouvido', 'oreille'],
    ];

    const aWords = a.split(/\s+/);
    const bWords = b.split(/\s+/);

    for (const group of synonymGroups) {
      const aMatch = group.some(syn => a.includes(syn) || aWords.some(w => group.includes(w)));
      const bMatch = group.some(syn => b.includes(syn) || bWords.some(w => group.includes(w)));
      if (aMatch && bMatch) return true;
    }
    return false;
  }

  /**
   * Rename an existing concern (e.g., when user switches languages)
   */
  async renameConcern(concernId: string, newTitle: string): Promise<void> {
    await this.db.query(
      `UPDATE health_concerns SET title = $1, updated_at = NOW() WHERE id = $2`,
      [newTitle, concernId]
    );
    logger.info({ concernId, newTitle }, 'Concern renamed (language change)');
  }

  /**
   * Create a brand new concern
   */
  async createConcern(userId: string, title: string, icon?: string): Promise<HealthConcern> {
    const result = await this.db.query<{
      id: string;
      user_id: string;
      title: string;
      status: ConcernStatus;
      summary_content: string | null;
      icon: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO health_concerns (id, user_id, title, status, icon, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'active', $3, NOW(), NOW())
       RETURNING id, user_id, title, status, summary_content, icon, created_at, updated_at`,
      [userId, title, icon || null]
    );

    const concern = this.mapRow(result.rows[0]!);
    logger.info({ userId, concernId: concern.id, title }, 'New health concern created');
    return concern;
  }

  /**
   * Update a concern's summary. Creates a snapshot if the change is meaningful.
   */
  async updateConcernSummary(
    concernId: string,
    newContent: string,
    changeType: ChangeType
  ): Promise<void> {
    const concern = await this.getConcernById(concernId);
    if (!concern) {
      throw new Error(`Concern not found: ${concernId}`);
    }

    const shouldSnapshot = this.hasMeaningfulChange(concern.summaryContent, newContent);

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Update the concern
      await client.query(
        `UPDATE health_concerns
         SET summary_content = $1, updated_at = NOW()
         WHERE id = $2`,
        [newContent, concernId]
      );

      // Create snapshot if meaningful change
      if (shouldSnapshot) {
        await client.query(
          `INSERT INTO concern_snapshots (id, concern_id, user_id, content, change_type, status, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())`,
          [concernId, concern.userId, newContent, changeType, concern.status]
        );

        logger.info(
          { concernId, changeType, userId: concern.userId },
          'Concern snapshot created'
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Change the status of a concern (active → improving → resolved)
   */
  async updateConcernStatus(concernId: string, newStatus: ConcernStatus): Promise<void> {
    const concern = await this.getConcernById(concernId);
    if (!concern) {
      throw new Error(`Concern not found: ${concernId}`);
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE health_concerns
         SET status = $1, updated_at = NOW()
         WHERE id = $2`,
        [newStatus, concernId]
      );

      // Always snapshot status changes
      await client.query(
        `INSERT INTO concern_snapshots (id, concern_id, user_id, content, change_type, status, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'status_change', $4, NOW())`,
        [concernId, concern.userId, concern.summaryContent || '', newStatus]
      );

      await client.query('COMMIT');

      logger.info(
        { concernId, oldStatus: concern.status, newStatus, userId: concern.userId },
        'Concern status updated'
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a concern and all its snapshots (cascading)
   */
  async deleteConcern(concernId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM health_concerns WHERE id = $1`,
      [concernId]
    );
    logger.info({ concernId }, 'Concern deleted');
  }

  /**
   * Get the full snapshot history for a concern
   */
  async getConcernHistory(concernId: string): Promise<ConcernSnapshot[]> {
    const result = await this.db.query<{
      id: string;
      concern_id: string;
      user_id: string;
      content: string;
      change_type: ChangeType;
      status: string | null;
      created_at: Date;
    }>(
      `SELECT id, concern_id, user_id, content, change_type, status, created_at
       FROM concern_snapshots
       WHERE concern_id = $1
       ORDER BY created_at DESC`,
      [concernId]
    );

    return result.rows.map(row => ({
      id: row.id,
      concernId: row.concern_id,
      userId: row.user_id,
      content: row.content,
      changeType: row.change_type,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get the primary (most recently updated) active concern for backward compat
   */
  async getPrimaryConcern(userId: string): Promise<HealthConcern | null> {
    const concerns = await this.getActiveConcerns(userId);
    return concerns[0] || null;
  }

  /**
   * Detect if new content is meaningfully different from old content.
   * Compares key structured fields rather than raw text.
   */
  hasMeaningfulChange(oldContent: string | null, newContent: string): boolean {
    if (!oldContent) return true;

    // Extract key fields from both
    const oldFields = this.extractKeyFields(oldContent);
    const newFields = this.extractKeyFields(newContent);

    // Compare each field
    for (const key of Object.keys(newFields)) {
      const oldVal = (oldFields[key] || '').trim().toLowerCase();
      const newVal = (newFields[key] || '').trim().toLowerCase();
      if (oldVal !== newVal && newVal.length > 0) {
        return true;
      }
    }

    // Also check raw length difference (>20% change = meaningful)
    const lengthDiff = Math.abs(oldContent.length - newContent.length);
    if (lengthDiff > oldContent.length * 0.2) {
      return true;
    }

    return false;
  }

  /**
   * Extract key fields from a summary for comparison
   */
  private extractKeyFields(content: string): Record<string, string> {
    const fields: Record<string, string> = {};

    const patterns: Record<string, RegExp> = {
      mainConcern: /^(?:Main concern|Concern|Motivo|Queixa|Motif):\s*(.+)/im,
      started: /^(?:Started|Onset|Inicio|Início|Début):\s*(.+)/im,
      location: /^(?:Location|Ubicación|Localização|Localisation):\s*(.+)/im,
      character: /^(?:Character|Carácter|Caráter|Caractère):\s*(.+)/im,
      severity: /^(?:Severity|Severidad|Gravidade|Sévérité):\s*(.+)/im,
      pattern: /^(?:Pattern|Patrón|Padrão|Schéma):\s*(.+)/im,
      whatHelps: /^(?:What helps|Helps|Mejora con|Melhora com|Améliore):\s*(.+)/im,
      whatWorsens: /^(?:What worsens|Worsens|Empeora con|Piora com|Aggrave):\s*(.+)/im,
      medications: /^(?:Medications|Medicamentos|Médicaments):\s*(.+)/im,
    };

    for (const [key, pattern] of Object.entries(patterns)) {
      const match = content.match(pattern);
      if (match && match[1]) {
        fields[key] = match[1].trim();
      }
    }

    return fields;
  }

  /**
   * Map a database row to a HealthConcern object
   */
  private mapRow(row: {
    id: string;
    user_id: string;
    title: string;
    status: ConcernStatus;
    summary_content: string | null;
    icon: string | null;
    created_at: Date;
    updated_at: Date;
  }): HealthConcern {
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      status: row.status as ConcernStatus,
      summaryContent: row.summary_content,
      icon: row.icon,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
