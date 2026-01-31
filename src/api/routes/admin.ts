import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db, query, queryOne, queryMany } from '../../infra/db/client';
import { authMiddleware } from '../middleware/auth';
import { BadRequestError, NotFoundError } from '../../shared/errors';

export const adminRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Apply auth to all admin routes
  app.addHook('preHandler', authMiddleware);

  // ============================================================================
  // Feature Flags
  // ============================================================================

  app.get('/flags', async (request, reply) => {
    const flags = await queryMany<{
      key: string;
      enabled: boolean;
      value: unknown;
      description: string | null;
      updated_at: Date;
    }>('SELECT key, enabled, value, description, updated_at FROM feature_flags ORDER BY key');

    return { success: true, data: flags };
  });

  app.get('/flags/:key', async (request, reply) => {
    const { key } = request.params as { key: string };

    const flag = await queryOne<{
      key: string;
      enabled: boolean;
      value: unknown;
      description: string | null;
    }>('SELECT key, enabled, value, description FROM feature_flags WHERE key = $1', [key]);

    if (!flag) {
      throw new NotFoundError(`Feature flag not found: ${key}`);
    }

    return { success: true, data: flag };
  });

  app.post('/flags/:key', async (request, reply) => {
    const { key } = request.params as { key: string };
    const schema = z.object({
      enabled: z.boolean(),
      value: z.unknown().optional(),
      description: z.string().optional(),
    });

    const body = schema.parse(request.body);

    await query(
      `INSERT INTO feature_flags (key, enabled, value, description, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (key) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         value = EXCLUDED.value,
         description = COALESCE(EXCLUDED.description, feature_flags.description),
         updated_at = NOW()`,
      [key, body.enabled, body.value ? JSON.stringify(body.value) : null, body.description]
    );

    request.log.info({ key, enabled: body.enabled }, 'Feature flag updated');

    return { success: true, message: `Flag "${key}" updated` };
  });

  app.delete('/flags/:key', async (request, reply) => {
    const { key } = request.params as { key: string };

    const result = await query('DELETE FROM feature_flags WHERE key = $1', [key]);

    if (result.rowCount === 0) {
      throw new NotFoundError(`Feature flag not found: ${key}`);
    }

    return { success: true, message: `Flag "${key}" deleted` };
  });

  // ============================================================================
  // Prompts
  // ============================================================================

  app.get('/prompts', async (request, reply) => {
    const prompts = await queryMany<{
      name: string;
      version: number;
      is_active: boolean;
      created_at: Date;
    }>(
      `SELECT name, version, is_active, created_at
       FROM prompt_versions
       ORDER BY name, version DESC`
    );

    return { success: true, data: prompts };
  });

  app.get('/prompts/:name', async (request, reply) => {
    const { name } = request.params as { name: string };

    const prompts = await queryMany<{
      id: string;
      version: number;
      content: string;
      is_active: boolean;
      metadata: unknown;
      created_at: Date;
    }>(
      `SELECT id, version, content, is_active, metadata, created_at
       FROM prompt_versions
       WHERE name = $1
       ORDER BY version DESC`,
      [name]
    );

    if (prompts.length === 0) {
      throw new NotFoundError(`Prompt not found: ${name}`);
    }

    return { success: true, data: prompts };
  });

  app.post('/prompts/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const schema = z.object({
      content: z.string().min(1),
      metadata: z.record(z.unknown()).optional(),
      activate: z.boolean().default(false),
    });

    const body = schema.parse(request.body);

    // Get next version number
    const current = await queryOne<{ max_version: number }>(
      'SELECT COALESCE(MAX(version), 0) as max_version FROM prompt_versions WHERE name = $1',
      [name]
    );
    const nextVersion = (current?.max_version || 0) + 1;

    // Insert new version
    const result = await queryOne<{ id: string }>(
      `INSERT INTO prompt_versions (id, name, version, content, is_active, metadata)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
       RETURNING id`,
      [name, nextVersion, body.content, body.activate, body.metadata ? JSON.stringify(body.metadata) : null]
    );

    // If activating, deactivate other versions
    if (body.activate) {
      await query(
        'UPDATE prompt_versions SET is_active = false WHERE name = $1 AND id != $2',
        [name, result!.id]
      );
    }

    request.log.info({ name, version: nextVersion, activated: body.activate }, 'Prompt version created');

    return {
      success: true,
      data: {
        id: result!.id,
        name,
        version: nextVersion,
        isActive: body.activate,
      },
    };
  });

  app.post('/prompts/:name/activate/:version', async (request, reply) => {
    const { name, version } = request.params as { name: string; version: string };
    const versionNum = parseInt(version, 10);

    // Check version exists
    const prompt = await queryOne<{ id: string }>(
      'SELECT id FROM prompt_versions WHERE name = $1 AND version = $2',
      [name, versionNum]
    );

    if (!prompt) {
      throw new NotFoundError(`Prompt version not found: ${name} v${versionNum}`);
    }

    // Deactivate all, activate this one
    await query('UPDATE prompt_versions SET is_active = false WHERE name = $1', [name]);
    await query('UPDATE prompt_versions SET is_active = true WHERE id = $1', [prompt.id]);

    request.log.info({ name, version: versionNum }, 'Prompt version activated');

    return { success: true, message: `Activated ${name} v${versionNum}` };
  });

  // ============================================================================
  // Templates
  // ============================================================================

  app.get('/templates', async (request, reply) => {
    const templates = await queryMany<{
      key: string;
      content_es: string;
      content_en: string | null;
      description: string | null;
      updated_at: Date;
    }>('SELECT key, content_es, content_en, description, updated_at FROM config_templates ORDER BY key');

    return { success: true, data: templates };
  });

  app.post('/templates/:key', async (request, reply) => {
    const { key } = request.params as { key: string };
    const schema = z.object({
      contentEs: z.string().min(1),
      contentEn: z.string().optional(),
      description: z.string().optional(),
    });

    const body = schema.parse(request.body);

    await query(
      `INSERT INTO config_templates (key, content_es, content_en, description, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (key) DO UPDATE SET
         content_es = EXCLUDED.content_es,
         content_en = EXCLUDED.content_en,
         description = COALESCE(EXCLUDED.description, config_templates.description),
         updated_at = NOW()`,
      [key, body.contentEs, body.contentEn, body.description]
    );

    request.log.info({ key }, 'Template updated');

    return { success: true, message: `Template "${key}" updated` };
  });

  // ============================================================================
  // Credit Costs
  // ============================================================================

  app.get('/costs', async (request, reply) => {
    const costs = await queryMany<{
      action: string;
      credits: number;
      description: string | null;
      updated_at: Date;
    }>('SELECT action, credits, description, updated_at FROM config_costs ORDER BY action');

    return { success: true, data: costs };
  });

  app.post('/costs/:action', async (request, reply) => {
    const { action } = request.params as { action: string };
    const schema = z.object({
      credits: z.number().int().min(0),
      description: z.string().optional(),
    });

    const body = schema.parse(request.body);

    await query(
      `INSERT INTO config_costs (action, credits, description, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (action) DO UPDATE SET
         credits = EXCLUDED.credits,
         description = COALESCE(EXCLUDED.description, config_costs.description),
         updated_at = NOW()`,
      [action, body.credits, body.description]
    );

    request.log.info({ action, credits: body.credits }, 'Credit cost updated');

    return { success: true, message: `Cost for "${action}" updated to ${body.credits} credits` };
  });

  // ============================================================================
  // Experiments
  // ============================================================================

  app.get('/experiments', async (request, reply) => {
    const experiments = await queryMany<{
      key: string;
      variants: string[];
      weights: number[];
      enabled: boolean;
      description: string | null;
    }>('SELECT key, variants, weights, enabled, description FROM experiments ORDER BY key');

    return { success: true, data: experiments };
  });

  app.post('/experiments/:key', async (request, reply) => {
    const { key } = request.params as { key: string };
    const schema = z.object({
      variants: z.array(z.string()).min(2),
      weights: z.array(z.number()).min(2),
      enabled: z.boolean().default(false),
      description: z.string().optional(),
    });

    const body = schema.parse(request.body);

    // Validate weights sum to 1 (or close)
    const weightSum = body.weights.reduce((a, b) => a + b, 0);
    if (Math.abs(weightSum - 1) > 0.01) {
      throw new BadRequestError('Experiment weights must sum to 1');
    }

    if (body.variants.length !== body.weights.length) {
      throw new BadRequestError('Variants and weights arrays must have same length');
    }

    await query(
      `INSERT INTO experiments (key, variants, weights, enabled, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE SET
         variants = EXCLUDED.variants,
         weights = EXCLUDED.weights,
         enabled = EXCLUDED.enabled,
         description = COALESCE(EXCLUDED.description, experiments.description)`,
      [key, JSON.stringify(body.variants), JSON.stringify(body.weights), body.enabled, body.description]
    );

    request.log.info({ key, variants: body.variants, enabled: body.enabled }, 'Experiment updated');

    return { success: true, message: `Experiment "${key}" updated` };
  });

  // ============================================================================
  // Stats & Monitoring
  // ============================================================================

  app.get('/stats', async (request, reply) => {
    const [users, messages, aiUsage] = await Promise.all([
      queryOne<{ count: number }>('SELECT COUNT(*) as count FROM users'),
      queryOne<{ count: number; today: number }>(
        `SELECT
           COUNT(*) as count,
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as today
         FROM messages`
      ),
      queryOne<{ total_tokens: number; total_cost: number }>(
        `SELECT
           SUM(input_tokens + output_tokens) as total_tokens,
           SUM(cost_cents) as total_cost
         FROM ai_usage
         WHERE created_at > NOW() - INTERVAL '24 hours'`
      ),
    ]);

    return {
      success: true,
      data: {
        users: {
          total: users?.count || 0,
        },
        messages: {
          total: messages?.count || 0,
          last24h: messages?.today || 0,
        },
        ai: {
          tokensLast24h: aiUsage?.total_tokens || 0,
          costLast24h: (aiUsage?.total_cost || 0) / 100, // Convert cents to dollars
        },
      },
    };
  });
};
