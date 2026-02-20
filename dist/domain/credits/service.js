"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreditService = void 0;
const client_1 = require("../../infra/db/client");
class CreditService {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Check if user has credits and reserve them (idempotent)
     * Uses the correlationId as idempotency key to prevent double-charging
     */
    async checkAndReserve(userId, action, correlationId) {
        const cost = await (0, client_1.getCreditCost)(action);
        // Check if we already processed this request
        const existing = await this.db.query(`SELECT id, status FROM credit_transactions
       WHERE idempotency_key = $1`, [correlationId]);
        const existingTx = existing.rows[0];
        if (existingTx) {
            // Already processed - return existing result
            const balance = await this.getBalance(userId);
            return {
                hasCredits: existingTx.status === 'confirmed' || existingTx.status === 'reserved',
                reservationId: existingTx.id,
                creditsRemaining: balance,
            };
        }
        // Get current balance
        const balance = await this.getBalance(userId);
        if (balance < cost) {
            // Not enough credits - record the failed attempt
            await this.db.query(`INSERT INTO credit_transactions
         (id, user_id, amount, action, status, idempotency_key, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'insufficient', $4, NOW())`, [userId, cost, action, correlationId]);
            return {
                hasCredits: false,
                creditsRemaining: balance,
            };
        }
        // Reserve credits (pending status)
        const result = await this.db.query(`INSERT INTO credit_transactions
       (id, user_id, amount, action, status, idempotency_key, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'reserved', $4, NOW())
       RETURNING id`, [userId, cost, action, correlationId]);
        return {
            hasCredits: true,
            reservationId: result.rows[0].id,
            creditsRemaining: balance - cost,
        };
    }
    /**
     * Confirm the credit debit after successful processing
     */
    async confirmDebit(reservationId) {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');
            // Get the reservation details
            const reservation = await client.query(`SELECT user_id, amount, status
         FROM credit_transactions
         WHERE id = $1
         FOR UPDATE`, [reservationId]);
            if (reservation.rows.length === 0) {
                throw new Error(`Reservation not found: ${reservationId}`);
            }
            const tx = reservation.rows[0];
            if (tx.status === 'confirmed') {
                // Already confirmed - idempotent
                await client.query('COMMIT');
                return;
            }
            if (tx.status !== 'reserved') {
                throw new Error(`Invalid reservation status: ${tx.status}`);
            }
            // Debit the credits
            await client.query(`UPDATE users
         SET credits_remaining = credits_remaining - $1
         WHERE id = $2`, [tx.amount, tx.user_id]);
            // Confirm the transaction
            await client.query(`UPDATE credit_transactions
         SET status = 'confirmed', confirmed_at = NOW()
         WHERE id = $1`, [reservationId]);
            await client.query('COMMIT');
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    /**
     * Cancel a reservation (e.g., if processing fails)
     */
    async cancelReservation(reservationId) {
        await this.db.query(`UPDATE credit_transactions
       SET status = 'cancelled', cancelled_at = NOW()
       WHERE id = $1 AND status = 'reserved'`, [reservationId]);
    }
    /**
     * Get user's current credit balance
     */
    async getBalance(userId) {
        const result = await this.db.query(`SELECT credits_remaining FROM users WHERE id = $1`, [userId]);
        return result.rows[0]?.credits_remaining || 0;
    }
    /**
     * Add credits to user's account (e.g., after purchase)
     */
    async addCredits(userId, amount, reason, referenceId) {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');
            // Add credits
            const result = await client.query(`UPDATE users
         SET credits_remaining = credits_remaining + $1
         WHERE id = $2
         RETURNING credits_remaining`, [amount, userId]);
            // Record the transaction
            await client.query(`INSERT INTO credit_transactions
         (id, user_id, amount, action, status, reference_id, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', $4, NOW())`, [userId, -amount, reason, referenceId] // Negative amount for credits added
            );
            await client.query('COMMIT');
            return result.rows[0].credits_remaining;
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
}
exports.CreditService = CreditService;
//# sourceMappingURL=service.js.map