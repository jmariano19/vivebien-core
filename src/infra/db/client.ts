import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../../config';
import { logger } from '../logging/logger';
import { DatabaseError } from '../../shared/errors';

// Connection pool with production-ready settings
export const db = new Pool({
  connectionString: config.databaseUrl,
  max: 20,                          // Max connections per instance
  min: 5,                           // Keep warm connections
  idleTimeoutMillis: 30000,         // Close after 30s idle
  connectionTimeoutMillis: 5000,    // Fail fast on connection
  maxUses: 10000,                   // Refresh connections periodically
  allowExitOnIdle: false,           // Keep pool alive
});

// Connection monitoring
db.on('connect', (client) => {
  logger.debug('New database connection established');
});

db.on('error', (err) => {
  logger.error({ error: err.message }, 'Unexpected database pool error');
});

db.on('remove', () => {
  logger.debug('Database connection removed from pool');
});

// Health check
export async function checkDatabaseHealth(): Promise<{
  healthy: boolean;
  latencyMs: number;
  connections: {
    total: number;
    idle: number;
    waiting: number;
  };
}> {
  const start = Date.now();

  try {
    await db.query('SELECT 1');
    const latencyMs = Date.now() - start;

    return {
      healthy: true,
      latencyMs,
      connections: {
        total: db.totalCount,
        idle: db.idleCount,
        waiting: db.waitingCount,
      },
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      connections: {
        total: db.totalCount,
        idle: db.idleCount,
        waiting: db.waitingCount,
      },
    };
  }
}

// ============================================================================
// Query Helpers
// ============================================================================

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();

  try {
    const result = await db.query<T>(text, params);
    const duration = Date.now() - start;

    if (duration > 1000) {
      logger.warn({ query: text.substring(0, 100), duration }, 'Slow query detected');
    }

    return result;
  } catch (error) {
    const err = error as Error;
    logger.error({ query: text.substring(0, 100), error: err.message }, 'Query failed');
    throw new DatabaseError(err.message, err);
  }
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] || null;
}

export async function queryMany<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await query<T>(text, params);
  return result.rows;
}

// ============================================================================
// Transaction Support
// ============================================================================

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ============================================================================
// Idempotency Support
// ============================================================================

export async function checkIdempotencyKey(key: string): Promise<unknown | null> {
  const result = await queryOne<{ result: unknown }>(
    `SELECT result FROM idempotency_keys
     WHERE key = $1 AND expires_at > NOW()`,
    [key]
  );

  return result?.result || null;
}

export async function setIdempotencyKey(
  key: string,
  result: unknown,
  ttlHours: number = 24
): Promise<void> {
  await query(
    `INSERT INTO idempotency_keys (key, result, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour' * $3)
     ON CONFLICT (key) DO NOTHING`,
    [key, JSON.stringify(result), ttlHours]
  );
}

// ============================================================================
// Common Queries
// ============================================================================

export async function getFeatureFlag(key: string): Promise<{
  enabled: boolean;
  value: unknown;
} | null> {
  const result = await queryOne<{ enabled: boolean; value: unknown }>(
    'SELECT enabled, value FROM feature_flags WHERE key = $1',
    [key]
  );

  return result;
}

export async function getActivePrompt(name: string): Promise<string | null> {
  const result = await queryOne<{ content: string }>(
    `SELECT content FROM prompt_versions
     WHERE name = $1 AND is_active = true
     ORDER BY version DESC LIMIT 1`,
    [name]
  );

  return result?.content || null;
}

export async function getConfigTemplate(
  key: string,
  language: 'es' | 'en' = 'es'
): Promise<string | null> {
  const result = await queryOne<{ content_es: string; content_en: string | null }>(
    'SELECT content_es, content_en FROM config_templates WHERE key = $1',
    [key]
  );

  if (!result) return null;
  return language === 'en' && result.content_en ? result.content_en : result.content_es;
}

export async function getCreditCost(action: string): Promise<number> {
  const result = await queryOne<{ credits: number }>(
    'SELECT credits FROM config_costs WHERE action = $1',
    [action]
  );

  return result?.credits || 1; // Default to 1 credit if not configured
}
