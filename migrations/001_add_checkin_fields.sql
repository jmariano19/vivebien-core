-- Migration: Add 24-hour check-in fields to conversation_state table
-- Run this migration before deploying the check-in feature

-- Add check-in status enum type
DO $$ BEGIN
    CREATE TYPE checkin_status AS ENUM ('not_scheduled', 'scheduled', 'sent', 'canceled', 'completed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Add check-in tracking columns to conversation_state
ALTER TABLE conversation_state
ADD COLUMN IF NOT EXISTS checkin_status checkin_status DEFAULT 'not_scheduled',
ADD COLUMN IF NOT EXISTS checkin_scheduled_for TIMESTAMP,
ADD COLUMN IF NOT EXISTS last_summary_created_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS last_user_message_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS last_bot_message_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS case_label VARCHAR(100);

-- Add index for scheduled check-ins (for quick lookups by the worker)
CREATE INDEX IF NOT EXISTS idx_conversation_state_checkin_scheduled
ON conversation_state (checkin_status, checkin_scheduled_for)
WHERE checkin_status = 'scheduled';

-- Add index for finding users with pending check-in responses
CREATE INDEX IF NOT EXISTS idx_conversation_state_checkin_sent
ON conversation_state (checkin_status)
WHERE checkin_status = 'sent';

-- Comment on columns
COMMENT ON COLUMN conversation_state.checkin_status IS '24h check-in status: not_scheduled, scheduled, sent, canceled, completed';
COMMENT ON COLUMN conversation_state.checkin_scheduled_for IS 'Timestamp when check-in is scheduled to be sent';
COMMENT ON COLUMN conversation_state.last_summary_created_at IS 'Timestamp when last summary was generated (triggers check-in)';
COMMENT ON COLUMN conversation_state.last_user_message_at IS 'Timestamp of last user message (for inactivity detection)';
COMMENT ON COLUMN conversation_state.last_bot_message_at IS 'Timestamp of last bot message';
COMMENT ON COLUMN conversation_state.case_label IS 'Simple label for the health issue, e.g. "your eye"';
