import { z } from 'zod';

const configSchema = z.object({
  // Environment
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  // Server
  port: z.coerce.number().default(3000),
  apiSecretKey: z.string().min(16),
  corsOrigins: z.string().transform((s) => s.split(',')).default('*'),

  // Database
  databaseUrl: z.string().url(),

  // Redis
  redisUrl: z.string().default('redis://localhost:6379'),

  // AI Services
  anthropicApiKey: z.string(),
  openaiApiKey: z.string().optional(),

  // Chatwoot
  chatwootUrl: z.string().url(),
  chatwootApiKey: z.string(),
  chatwootAccountId: z.coerce.number(),

  // Worker
  workerConcurrency: z.coerce.number().default(50),
  jobTimeoutMs: z.coerce.number().default(120000),

  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Rate limiting
  claudeRpmLimit: z.coerce.number().default(50),
  whisperRpmLimit: z.coerce.number().default(30),
});

function loadConfig() {
  const result = configSchema.safeParse({
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    apiSecretKey: process.env.API_SECRET_KEY,
    corsOrigins: process.env.CORS_ORIGINS,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    chatwootUrl: process.env.CHATWOOT_URL,
    chatwootApiKey: process.env.CHATWOOT_API_KEY,
    chatwootAccountId: process.env.CHATWOOT_ACCOUNT_ID,
    workerConcurrency: process.env.WORKER_CONCURRENCY,
    jobTimeoutMs: process.env.JOB_TIMEOUT_MS,
    logLevel: process.env.LOG_LEVEL,
    claudeRpmLimit: process.env.CLAUDE_RPM_LIMIT,
    whisperRpmLimit: process.env.WHISPER_RPM_LIMIT,
  });

  if (!result.success) {
    console.error('Configuration validation failed:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
export type Config = z.infer<typeof configSchema>;
