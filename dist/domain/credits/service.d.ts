import { Pool } from 'pg';
import { CreditCheck } from '../../shared/types';
export declare class CreditService {
    private db;
    constructor(db: Pool);
    /**
     * Check if user has credits and reserve them (idempotent)
     * Uses the correlationId as idempotency key to prevent double-charging
     */
    checkAndReserve(userId: string, action: string, correlationId: string): Promise<CreditCheck>;
    /**
     * Confirm the credit debit after successful processing
     */
    confirmDebit(reservationId: string): Promise<void>;
    /**
     * Cancel a reservation (e.g., if processing fails)
     */
    cancelReservation(reservationId: string): Promise<void>;
    /**
     * Get user's current credit balance
     */
    getBalance(userId: string): Promise<number>;
    /**
     * Add credits to user's account (e.g., after purchase)
     */
    addCredits(userId: string, amount: number, reason: string, referenceId?: string): Promise<number>;
}
//# sourceMappingURL=service.d.ts.map