import { Pool } from 'pg';
import { CreditCheck } from '../../shared/types';
import { InsufficientCreditsError } from '../../shared/errors';
import { getCreditCost } from '../../infra/db/client';

export class CreditService {
  constructor(private db: Pool) {}

  /**
   * Check if user has credits and reserve them (idempotent)
   * Uses the correlationId as idempotency key to prevent double-charging
   */
  async checkAndReserve(
    userId: string,
    action: string,
    correlationId: string
  ): Promise<CreditCheck> {
    const cost = await getCreditCost(action);

    // Check if we already processed this request
    const existing = await this.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM credit_transactions
       WHERE idempotency_key = $1`,
      [correlationId]
    );

    if (existing.rows.length > 0) {
      const tx = existing.rows[0];
      // Already processed - return existing result
      const balance = await this.getBalance(userId);
      return {
        hasCredits: tx.status === 'confirmed',
        reservationId: tx.id,
        creditsRemaining: balance,
      };
    }

    // Get current balance
    const balance = await this.getBalance(userId);

    if (balance < cost) {
      // Not enough credits - record the failed attempt
      await this.db.query(
        `INSERT INTO credit_transactions
         (id, user_id, amount, action, status, idempotency_key, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'insufficient', $4, NOW())`,
        [userId, cost, action, correlationId]
      );

      return {
        hasCredits: false,
        creditsRemaining: balance,
      };
    }

    // Reserve credits (pending status)
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO credit_transactions
       (id, user_id, amount, action, status, idempotency_key, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'reserved', $4, NOW())
       RETURNING id`,
      [userId, cost, action, correlationId]
    );

    return {
      hasCredits: true,
      reservationId: result.rows[0].id,
      creditsRemaining: balance - cost,
    };
  }

  /**
   * Confirm the credit debit after successful processing
   */
  async confirmDebit(reservationId: string): Promise<void> {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      // Get the reservation details
      const reservation = await client.query<{
        user_id: string;
        amount: number;
        status: string;
      }>(
        `SELECT user_id, amount, status
         FROM credit_transactions
         WHERE id = $1
         FOR UPDATE`,
        [reservationId]
      );

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
      await client.query(
        `UPDATE billing_accounts
         SET credits = credits - $1
         WHERE user_id = $2`,
        [tx.amount, tx.user_id]
      );

      // Confirm the transaction
      await client.query(
        `UPDATE credit_transactions
         SET status = 'confirmed', confirmed_at = NOW()
         WHERE id = $1`,
        [reservationId]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Cancel a reservation (e.g., if processing fails)
   */
  async cancelReservation(reservationId: string): Promise<void> {
    await this.db.query(
      `UPDATE credit_transactions
       SET status = 'cancelled', cancelled_at = NOW()
       WHERE id = $1 AND status = 'reserved'`,
      [reservationId]
    );
  }

  /**
   * Get user's current credit balance
   */
  async getBalance(userId: string): Promise<number> {
    const result = await this.db.query<{ credits: number }>(
      `SELECT credits FROM billing_accounts WHERE user_id = $1`,
      [userId]
    );

    return result.rows[0]?.credits || 0;
  }

  /**
   * Add credits to user's account (e.g., after purchase)
   */
  async addCredits(
    userId: string,
    amount: number,
    reason: string,
    referenceId?: string
  ): Promise<number> {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      // Add credits
      const result = await client.query<{ credits: number }>(
        `UPDATE billing_accounts
         SET credits = credits + $1
         WHERE user_id = $2
         RETURNING credits`,
        [amount, userId]
      );

      // Record the transaction
      await client.query(
        `INSERT INTO credit_transactions
         (id, user_id, amount, action, status, reference_id, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', $4, NOW())`,
        [userId, -amount, reason, referenceId] // Negative amount for credits added
      );

      await client.query('COMMIT');

      return result.rows[0].credits;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
