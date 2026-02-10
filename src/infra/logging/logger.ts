import pino, { Logger } from 'pino';
import { config } from '../../config';
import { db } from '../db/client';

export const logger = pino({
  level: config.logLevel,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'vivebien-core',
    env: config.nodeEnv,
  },
  // Pretty print in development
  ...(config.nodeEnv === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  }),
});

// ============================================================================
// Execution Logging
// ============================================================================

interface ExecutionLogInput {
  correlationId: string;
  jobId?: string;
  userId?: string;
  action: string;
  status: 'started' | 'completed' | 'failed';
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

export async function saveExecutionLog(log: ExecutionLogInput): Promise<void> {
  try {
    await db.query(
      `INSERT INTO execution_logs
       (id, correlation_id, job_id, user_id, action, status, duration_ms, input, output, error)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        log.correlationId,
        log.jobId,
        log.userId,
        log.action,
        log.status,
        log.durationMs,
        log.input ? JSON.stringify(log.input) : null,
        log.output ? JSON.stringify(log.output) : null,
        log.error ? JSON.stringify(log.error) : null,
      ]
    );
  } catch (error) {
    // Don't fail the main operation if logging fails
    logger.error({ error, log }, 'Failed to save execution log');
  }
}

export async function logExecution<T>(
  correlationId: string,
  action: string,
  fn: () => Promise<T>,
  parentLogger?: Logger,
  options?: {
    logInput?: unknown;
    skipDbLog?: boolean;
  }
): Promise<T> {
  const log = parentLogger || logger;
  const startTime = Date.now();

  log.debug({ correlationId, action }, `Starting ${action}`);

  if (!options?.skipDbLog) {
    await saveExecutionLog({
      correlationId,
      action,
      status: 'started',
      input: options?.logInput,
    });
  }

  try {
    const result = await fn();
    const durationMs = Date.now() - startTime;

    log.info({ correlationId, action, durationMs }, `Completed ${action}`);

    if (!options?.skipDbLog) {
      await saveExecutionLog({
        correlationId,
        action,
        status: 'completed',
        durationMs,
      });
    }

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const err = error as Error;

    log.error({
      correlationId,
      action,
      durationMs,
      error: err.message,
      stack: err.stack,
    }, `Failed ${action}`);

    if (!options?.skipDbLog) {
      await saveExecutionLog({
        correlationId,
        action,
        status: 'failed',
        durationMs,
        error: { message: err.message, stack: err.stack },
      });
    }

    throw error;
  }
}

// ============================================================================
// AI Usage Logging
// ============================================================================

interface AIUsageLog {
  userId: string;
  correlationId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export async function logAIUsage(usage: AIUsageLog): Promise<void> {
  // Calculate cost using actual per-model pricing (USD per million tokens)
  const modelPricing: Record<string, { input: number; output: number }> = {
    // Opus 4.5
    'claude-opus-4-5-20251101':   { input: 15.0,  output: 75.0 },
    // Sonnet 4.5
    'claude-sonnet-4-5-20250929': { input: 3.0,   output: 15.0 },
    // Sonnet 4
    'claude-sonnet-4-20250514':   { input: 3.0,   output: 15.0 },
    // Haiku 4.5
    'claude-haiku-4-5-20251001':  { input: 0.80,  output: 4.0 },
  };

  // Match model string (API may return resolved model names)
  const pricing = modelPricing[usage.model]
    || (usage.model.includes('opus')   ? modelPricing['claude-opus-4-5-20251101']
    :   usage.model.includes('haiku')  ? modelPricing['claude-haiku-4-5-20251001']
    :   { input: 3.0, output: 15.0 }); // default to Sonnet pricing

  const costPerInputToken = pricing!.input / 1_000_000;
  const costPerOutputToken = pricing!.output / 1_000_000;
  const costUsd =
    (usage.inputTokens * costPerInputToken) +
    (usage.outputTokens * costPerOutputToken);

  try {
    await db.query(
      `INSERT INTO ai_usage
       (id, user_id, correlation_id, model, input_tokens, output_tokens, cost_usd, latency_ms)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
      [
        usage.userId,
        usage.correlationId,
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        costUsd,
        usage.latencyMs,
      ]
    );
  } catch (error) {
    logger.error({ error, usage }, 'Failed to log AI usage');
  }
}

// ============================================================================
// Child Logger Factory
// ============================================================================

export function createChildLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
