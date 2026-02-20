"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const zod_1 = require("zod");
const configSchema = zod_1.z.object({
    // Environment
    nodeEnv: zod_1.z.enum(['development', 'production', 'test']).default('development'),
    // Server
    port: zod_1.z.coerce.number().default(3000),
    apiSecretKey: zod_1.z.string().min(16),
    corsOrigins: zod_1.z.string().transform((s) => s.split(',')).default('https://carelog.vivebien.io'),
    // Database
    databaseUrl: zod_1.z.string().url(),
    // Redis
    redisUrl: zod_1.z.string().default('redis://localhost:6379'),
    // AI Services
    anthropicApiKey: zod_1.z.string(),
    openaiApiKey: zod_1.z.string().optional(),
    // Chatwoot
    chatwootUrl: zod_1.z.string().url(),
    chatwootApiKey: zod_1.z.string(),
    chatwootAccountId: zod_1.z.coerce.number(),
    // Worker
    workerConcurrency: zod_1.z.coerce.number().default(50),
    jobTimeoutMs: zod_1.z.coerce.number().default(120000),
    // Logging
    logLevel: zod_1.z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    // Rate limiting
    claudeRpmLimit: zod_1.z.coerce.number().default(50),
    whisperRpmLimit: zod_1.z.coerce.number().default(30),
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
        // Logger not available yet during config init — use stderr
        process.stderr.write('Configuration validation failed:\n');
        process.stderr.write(JSON.stringify(result.error.format(), null, 2) + '\n');
        process.exit(1);
    }
    return result.data;
}
exports.config = loadConfig();
//# sourceMappingURL=config.js.map