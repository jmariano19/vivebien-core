-- Migration: Multi-concern health tracking with history snapshots
-- Adds support for multiple active health concerns per user,
-- each with their own status lifecycle and change history.

-- Concern entities (one per health topic per user)
CREATE TABLE IF NOT EXISTS health_concerns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  title VARCHAR(255) NOT NULL,
  status VARCHAR(20) DEFAULT 'active',
  summary_content TEXT,
  icon VARCHAR(10),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- History snapshots (created only on meaningful changes)
CREATE TABLE IF NOT EXISTS concern_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  concern_id UUID NOT NULL REFERENCES health_concerns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  content TEXT NOT NULL,
  change_type VARCHAR(30) NOT NULL,
  status VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_concerns_user ON health_concerns(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_concern ON concern_snapshots(concern_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_user ON concern_snapshots(user_id, created_at DESC);

-- Migrate existing health_summary data from memories table into health_concerns
-- This creates one concern per user who already has a summary
INSERT INTO health_concerns (id, user_id, title, status, summary_content, created_at, updated_at)
SELECT
  gen_random_uuid(),
  m.user_id,
  COALESCE(
    -- Try to extract the main concern title from the summary content
    CASE
      WHEN m.content ~* 'Main concern:\s*(.+)' THEN substring(m.content from '(?i)Main concern:\s*(.+?)(?:\n|$)')
      WHEN m.content ~* 'Concern:\s*(.+)' THEN substring(m.content from '(?i)Concern:\s*(.+?)(?:\n|$)')
      WHEN m.content ~* 'Motivo:\s*(.+)' THEN substring(m.content from '(?i)Motivo:\s*(.+?)(?:\n|$)')
      WHEN m.content ~* 'Queixa:\s*(.+)' THEN substring(m.content from '(?i)Queixa:\s*(.+?)(?:\n|$)')
      WHEN m.content ~* 'Motif:\s*(.+)' THEN substring(m.content from '(?i)Motif:\s*(.+?)(?:\n|$)')
      ELSE 'Health concern'
    END,
    'Health concern'
  ),
  'active',
  m.content,
  m.created_at,
  m.created_at
FROM memories m
WHERE m.category = 'health_summary'
AND NOT EXISTS (
  SELECT 1 FROM health_concerns hc WHERE hc.user_id = m.user_id
);

-- Create initial snapshot for each migrated concern
INSERT INTO concern_snapshots (id, concern_id, user_id, content, change_type, status, created_at)
SELECT
  gen_random_uuid(),
  hc.id,
  hc.user_id,
  hc.summary_content,
  'auto_update',
  hc.status,
  hc.created_at
FROM health_concerns hc
WHERE NOT EXISTS (
  SELECT 1 FROM concern_snapshots cs WHERE cs.concern_id = hc.id
);
