"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
exports.checkDatabaseHealth = checkDatabaseHealth;
exports.query = query;
exports.queryOne = queryOne;
exports.queryMany = queryMany;
exports.withTransaction = withTransaction;
exports.checkIdempotencyKey = checkIdempotencyKey;
exports.setIdempotencyKey = setIdempotencyKey;
exports.getFeatureFlag = getFeatureFlag;
exports.getActivePrompt = getActivePrompt;
exports.getConfigTemplate = getConfigTemplate;
exports.getCreditCost = getCreditCost;
const pg_1 = require("pg");
const config_1 = require("../../config");
const logger_1 = require("../logging/logger");
const errors_1 = require("../../shared/errors");
// Connection pool with production-ready settings
exports.db = new pg_1.Pool({
    connectionString: config_1.config.databaseUrl,
    max: 20, // Max connections per instance
    min: 5, // Keep warm connections
    idleTimeoutMillis: 30000, // Close after 30s idle
    connectionTimeoutMillis: 5000, // Fail fast on connection
    maxUses: 10000, // Refresh connections periodically
    allowExitOnIdle: false, // Keep pool alive
});
// Connection monitoring
exports.db.on('connect', (client) => {
    logger_1.logger.debug('New database connection established');
});
exports.db.on('error', (err) => {
    logger_1.logger.error({ error: err.message }, 'Unexpected database pool error');
});
exports.db.on('remove', () => {
    logger_1.logger.debug('Database connection removed from pool');
});
// Health check
async function checkDatabaseHealth() {
    const start = Date.now();
    try {
        await exports.db.query('SELECT 1');
        const latencyMs = Date.now() - start;
        return {
            healthy: true,
            latencyMs,
            connections: {
                total: exports.db.totalCount,
                idle: exports.db.idleCount,
                waiting: exports.db.waitingCount,
            },
        };
    }
    catch (error) {
        return {
            healthy: false,
            latencyMs: Date.now() - start,
            connections: {
                total: exports.db.totalCount,
                idle: exports.db.idleCount,
                waiting: exports.db.waitingCount,
            },
        };
    }
}
// ============================================================================
// Query Helpers
// ============================================================================
async function query(text, params) {
    const start = Date.now();
    try {
        const result = await exports.db.query(text, params);
        const duration = Date.now() - start;
        if (duration > 1000) {
            logger_1.logger.warn({ query: text.substring(0, 100), duration }, 'Slow query detected');
        }
        return result;
    }
    catch (error) {
        const err = error;
        logger_1.logger.error({ query: text.substring(0, 100), error: err.message }, 'Query failed');
        throw new errors_1.DatabaseError(err.message, err);
    }
}
async function queryOne(text, params) {
    const result = await query(text, params);
    return result.rows[0] || null;
}
async function queryMany(text, params) {
    const result = await query(text, params);
    return result.rows;
}
// ============================================================================
// Transaction Support
// ============================================================================
async function withTransaction(callback) {
    const client = await exports.db.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
    finally {
        client.release();
    }
}
// ============================================================================
// Idempotency Support
// ============================================================================
async function checkIdempotencyKey(key) {
    const result = await queryOne(`SELECT result FROM idempotency_keys
     WHERE key = $1 AND expires_at > NOW()`, [key]);
    return result?.result || null;
}
async function setIdempotencyKey(key, result, ttlHours = 24) {
    await query(`INSERT INTO idempotency_keys (key, result, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour' * $3)
     ON CONFLICT (key) DO NOTHING`, [key, JSON.stringify(result), ttlHours]);
}
// ============================================================================
// Common Queries
// ============================================================================
async function getFeatureFlag(key) {
    const result = await queryOne('SELECT enabled, value FROM feature_flags WHERE key = $1', [key]);
    return result;
}
async function getActivePrompt(name) {
    const result = await queryOne(`SELECT content FROM prompt_versions
     WHERE name = $1 AND is_active = true
     ORDER BY version DESC LIMIT 1`, [name]);
    return result?.content || null;
}
async function getConfigTemplate(key, language = 'es') {
    const result = await queryOne('SELECT content_es, content_en FROM config_templates WHERE key = $1', [key]);
    if (!result)
        return null;
    return language === 'en' && result.content_en ? result.content_en : result.content_es;
}
async function getCreditCost(action) {
    const result = await queryOne('SELECT credits FROM config_costs WHERE action = $1', [action]);
    return result?.credits || 1; // Default to 1 credit if not configured
}
//# sourceMappingURL=client.js.map