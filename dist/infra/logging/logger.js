"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
exports.saveExecutionLog = saveExecutionLog;
exports.logExecution = logExecution;
exports.logAIUsage = logAIUsage;
exports.createChildLogger = createChildLogger;
const pino_1 = __importDefault(require("pino"));
const config_1 = require("../../config");
const client_1 = require("../db/client");
exports.logger = (0, pino_1.default)({
    level: config_1.config.logLevel,
    formatters: {
        level: (label) => ({ level: label }),
    },
    timestamp: pino_1.default.stdTimeFunctions.isoTime,
    base: {
        service: 'vivebien-core',
        env: config_1.config.nodeEnv,
    },
    // Pretty print in development
    ...(config_1.config.nodeEnv === 'development' && {
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
async function saveExecutionLog(log) {
    try {
        await client_1.db.query(`INSERT INTO execution_logs
       (id, correlation_id, job_id, user_id, action, status, duration_ms, input, output, error)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
            log.correlationId,
            log.jobId,
            log.userId,
            log.action,
            log.status,
            log.durationMs,
            log.input ? JSON.stringify(log.input) : null,
            log.output ? JSON.stringify(log.output) : null,
            log.error ? JSON.stringify(log.error) : null,
        ]);
    }
    catch (error) {
        // Don't fail the main operation if logging fails
        exports.logger.error({ error, log }, 'Failed to save execution log');
    }
}
async function logExecution(correlationId, action, fn, parentLogger, options) {
    const log = parentLogger || exports.logger;
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
    }
    catch (error) {
        const durationMs = Date.now() - startTime;
        const err = error;
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
async function logAIUsage(usage) {
    // Calculate cost using actual per-model pricing (USD per million tokens)
    const modelPricing = {
        // Opus 4.5
        'claude-opus-4-5-20251101': { input: 15.0, output: 75.0 },
        // Sonnet 4.5
        'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
        // Sonnet 4
        'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
        // Haiku 4.5
        'claude-haiku-4-5-20251001': { input: 0.80, output: 4.0 },
    };
    // Match model string (API may return resolved model names)
    const pricing = modelPricing[usage.model]
        || (usage.model.includes('opus') ? modelPricing['claude-opus-4-5-20251101']
            : usage.model.includes('haiku') ? modelPricing['claude-haiku-4-5-20251001']
                : { input: 3.0, output: 15.0 }); // default to Sonnet pricing
    const costPerInputToken = pricing.input / 1_000_000;
    const costPerOutputToken = pricing.output / 1_000_000;
    const costUsd = (usage.inputTokens * costPerInputToken) +
        (usage.outputTokens * costPerOutputToken);
    try {
        await client_1.db.query(`INSERT INTO ai_usage
       (user_id, correlation_id, model, input_tokens, output_tokens, cost_usd, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
            usage.userId || null,
            usage.correlationId,
            usage.model,
            usage.inputTokens,
            usage.outputTokens,
            costUsd,
            usage.latencyMs,
        ]);
    }
    catch (error) {
        exports.logger.error({ error, usage }, 'Failed to log AI usage');
    }
}
// ============================================================================
// Child Logger Factory
// ============================================================================
function createChildLogger(bindings) {
    return exports.logger.child(bindings);
}
//# sourceMappingURL=logger.js.map