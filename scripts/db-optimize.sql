-- ViveBien Core - Database Optimization Script
-- Run this script to add indexes and optimize query performance
-- Execute via: psql -h 85.209.95.19 -U postgres -d projecto-1 -f scripts/db-optimize.sql

-- ============================================================================
-- INDEXES FOR USERS TABLE
-- ============================================================================

-- Index for phone lookups (most common query)
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

-- Index for language-based queries
CREATE INDEX IF NOT EXISTS idx_users_language ON users(language);

-- ============================================================================
-- INDEXES FOR MESSAGES TABLE
-- ============================================================================

-- Composite index for user message history (used in getRecentMessages)
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at DESC);

-- Index for conversation lookups
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

-- ============================================================================
-- INDEXES FOR MEMORIES TABLE
-- ============================================================================

-- Composite index for health summary lookups (most critical query)
CREATE INDEX IF NOT EXISTS idx_memories_user_category_created
ON memories(user_id, category, created_at DESC);

-- Index for category filtering
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);

-- ============================================================================
-- INDEXES FOR CONVERSATION_STATE TABLE
-- ============================================================================

-- Primary lookup is by user_id (should already have unique constraint)
-- Add index for phase-based queries if needed
CREATE INDEX IF NOT EXISTS idx_conversation_state_phase ON conversation_state(phase);

-- ============================================================================
-- INDEXES FOR BILLING_ACCOUNTS TABLE
-- ============================================================================

-- Index for user billing lookups
CREATE INDEX IF NOT EXISTS idx_billing_user ON billing_accounts(user_id);

-- Index for status filtering (find active accounts)
CREATE INDEX IF NOT EXISTS idx_billing_status ON billing_accounts(status);

-- ============================================================================
-- ANALYZE TABLES
-- ============================================================================

-- Update statistics for query planner
ANALYZE users;
ANALYZE messages;
ANALYZE memories;
ANALYZE conversation_state;
ANALYZE billing_accounts;

-- ============================================================================
-- VERIFY INDEXES
-- ============================================================================

-- List all indexes on our tables
SELECT
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename IN ('users', 'messages', 'memories', 'conversation_state', 'billing_accounts')
ORDER BY tablename, indexname;
