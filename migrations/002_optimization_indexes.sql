-- Migration: 002_optimization_indexes.sql
-- Purpose: Add critical indexes and constraints for scale
-- Run this migration to optimize database performance
-- Date: 2026-02-03

-- =============================================================================
-- TIER 1: CRITICAL INDEXES (Run immediately)
-- =============================================================================

-- Users: Phone lookup on every inbound message
-- Without this, every message scans the entire users table
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

-- Credit transactions: Prevent double-charging
ALTER TABLE credit_transactions
  ADD CONSTRAINT IF NOT EXISTS uk_credit_tx_idempotency UNIQUE(idempotency_key);

-- =============================================================================
-- TIER 2: HIGH-IMPACT INDEXES (Major performance gains)
-- =============================================================================

-- Messages: Efficient conversation history lookups
-- Used by getRecentMessages() on every inbound message
CREATE INDEX IF NOT EXISTS idx_messages_user_created
  ON messages(user_id, created_at DESC);

-- Memories: Fast health summary retrieval
-- Used by getHealthSummary() and updateHealthSummary()
CREATE INDEX IF NOT EXISTS idx_memories_user_category_created
  ON memories(user_id, category, created_at DESC);

-- Conversation state: Phase-based lookups
CREATE INDEX IF NOT EXISTS idx_conversation_state_phase
  ON conversation_state(phase)
  WHERE phase IS NOT NULL;

-- Credit transactions: User history
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_created
  ON credit_transactions(user_id, created_at DESC);

-- =============================================================================
-- TIER 3: MAINTENANCE INDEXES
-- =============================================================================

-- Execution logs: Time-based queries and cleanup
CREATE INDEX IF NOT EXISTS idx_execution_logs_created
  ON execution_logs(created_at DESC);

-- Idempotency keys: Cleanup expired entries
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_cleanup
  ON idempotency_keys(expires_at)
  WHERE expires_at IS NOT NULL;

-- Experiment assignments: A/B testing lookups
CREATE INDEX IF NOT EXISTS idx_experiment_assignments_experiment
  ON experiment_assignments(experiment_key, user_id);

-- =============================================================================
-- FOREIGN KEY CONSTRAINTS (Data integrity)
-- =============================================================================

-- Note: These use DO blocks to handle cases where constraints already exist

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_messages_user_id'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT fk_messages_user_id
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_memories_user_id'
  ) THEN
    ALTER TABLE memories
      ADD CONSTRAINT fk_memories_user_id
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_conversation_state_user_id'
  ) THEN
    ALTER TABLE conversation_state
      ADD CONSTRAINT fk_conversation_state_user_id
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_credit_transactions_user_id'
  ) THEN
    ALTER TABLE credit_transactions
      ADD CONSTRAINT fk_credit_transactions_user_id
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_experiment_assignments_user_id'
  ) THEN
    ALTER TABLE experiment_assignments
      ADD CONSTRAINT fk_experiment_assignments_user_id
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- =============================================================================
-- CLEANUP MAINTENANCE (Run periodically via pg_cron or application)
-- =============================================================================

-- Cleanup old execution logs (keep 7 days)
-- Uncomment to run manually or schedule with pg_cron:
-- DELETE FROM execution_logs WHERE created_at < NOW() - INTERVAL '7 days';

-- Cleanup expired idempotency keys
-- DELETE FROM idempotency_keys WHERE expires_at < NOW();

-- =============================================================================
-- COMMENTS (Documentation)
-- =============================================================================

COMMENT ON INDEX idx_users_phone IS 'Critical: Phone lookup on every inbound message';
COMMENT ON INDEX idx_messages_user_created IS 'Conversation history for getRecentMessages()';
COMMENT ON INDEX idx_memories_user_category_created IS 'Health summary lookups';
COMMENT ON INDEX idx_conversation_state_phase IS 'Phase-based user queries';
