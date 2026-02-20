"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserService = void 0;
const errors_1 = require("../../shared/errors");
class UserService {
    db;
    constructor(db) {
        this.db = db;
    }
    async loadOrCreate(phone) {
        // Validate phone
        if (!this.isValidPhone(phone)) {
            throw new errors_1.InvalidPhoneError(phone);
        }
        // Try to find existing user
        const existing = await this.findByPhone(phone);
        if (existing) {
            return { ...existing, isNew: false };
        }
        // Create new user
        const newUser = await this.create(phone);
        return { ...newUser, isNew: true };
    }
    async findByPhone(phone) {
        const result = await this.db.query(`SELECT id, phone, name, language, timezone, created_at
       FROM users
       WHERE phone = $1`, [phone]);
        const row = result.rows[0];
        if (!row) {
            return null;
        }
        return {
            id: row.id,
            phone: row.phone,
            name: row.name || undefined,
            language: row.language,
            timezone: row.timezone,
            createdAt: row.created_at,
        };
    }
    async findById(userId) {
        const result = await this.db.query(`SELECT id, phone, name, language, timezone, created_at
       FROM users
       WHERE id = $1`, [userId]);
        const row = result.rows[0];
        if (!row) {
            return null;
        }
        return {
            id: row.id,
            phone: row.phone,
            name: row.name || undefined,
            language: row.language,
            timezone: row.timezone,
            createdAt: row.created_at,
        };
    }
    async create(phone) {
        // Start transaction to create user and billing account
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');
            // Create user with default settings
            const userResult = await client.query(`INSERT INTO users (id, phone, language, timezone, created_at)
         VALUES (gen_random_uuid(), $1, 'en', 'America/Mexico_City', NOW())
         RETURNING id, phone, language, timezone, created_at`, [phone]);
            const user = userResult.rows[0];
            // Create billing account with free credits
            await client.query(`INSERT INTO billing_accounts (id, user_id, credits, plan, status, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'free', 'active', NOW())`, [user.id, 10] // 10 free credits for new users
            );
            // Initialize conversation state
            await client.query(`INSERT INTO conversation_state (user_id, phase, message_count, created_at)
         VALUES ($1, 'onboarding', 0, NOW())
         ON CONFLICT (user_id) DO NOTHING`, [user.id]);
            await client.query('COMMIT');
            return {
                id: user.id,
                phone: user.phone,
                language: user.language,
                timezone: user.timezone,
                createdAt: user.created_at,
            };
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async updateLanguage(userId, language) {
        await this.db.query('UPDATE users SET language = $1 WHERE id = $2', [language, userId]);
    }
    async updateName(userId, name) {
        await this.db.query('UPDATE users SET name = $1 WHERE id = $2', [name, userId]);
    }
    isValidPhone(phone) {
        // Basic validation: starts with +, has 10-15 digits
        const cleaned = phone.replace(/[^\d+]/g, '');
        return /^\+\d{10,15}$/.test(cleaned);
    }
}
exports.UserService = UserService;
//# sourceMappingURL=service.js.map