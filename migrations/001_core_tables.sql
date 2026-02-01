-- ============================================================================
-- ViveBien Core - Database Migrations
-- ============================================================================
-- Run these migrations on your existing ViveBien PostgreSQL database
-- These add new tables required by vivebien-core without affecting existing data

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. Execution Logs - Track every action for debugging
-- ============================================================================
CREATE TABLE IF NOT EXISTS execution_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id VARCHAR(64) NOT NULL,
  job_id VARCHAR(64),
  user_id UUID,
  action VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL,
  duration_ms INTEGER,
  input JSONB,
  output JSONB,
  error JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_execution_logs_correlation ON execution_logs(correlation_id);
CREATE INDEX IF NOT EXISTS idx_execution_logs_user ON execution_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_execution_logs_created ON execution_logs(created_at);

-- ============================================================================
-- 2. Idempotency Keys - Prevent duplicate webhook processing
-- ============================================================================
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

-- Cleanup expired keys (run via cron or pg_cron)
-- DELETE FROM idempotency_keys WHERE expires_at < NOW();

-- ============================================================================
-- 3. Feature Flags - Runtime toggles for features
-- ============================================================================
CREATE TABLE IF NOT EXISTS feature_flags (
  key VARCHAR(100) PRIMARY KEY,
  enabled BOOLEAN DEFAULT false,
  value JSONB,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default flags
INSERT INTO feature_flags (key, enabled, description) VALUES
  ('kill_switch', false, 'Emergency stop for all processing'),
  ('maintenance_mode', false, 'Show maintenance message to all users'),
  ('enable_audio_transcription', true, 'Process audio messages with Whisper'),
  ('enable_experiments', false, 'Enable A/B testing')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 4. Prompt Versions - Versioned AI prompts with rollback
-- ============================================================================
CREATE TABLE IF NOT EXISTS prompt_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  is_active BOOLEAN DEFAULT false,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(name, version)
);

CREATE INDEX IF NOT EXISTS idx_prompts_active ON prompt_versions(name, is_active) WHERE is_active = true;

-- Insert default system prompt
INSERT INTO prompt_versions (name, version, content, is_active) VALUES
  ('system', 1, 'Eres un asistente de bienestar emocional llamado ViveBien.
Tu objetivo es ayudar a las personas a mejorar su bienestar mental y emocional.
Responde siempre en español a menos que el usuario escriba en otro idioma.
Sé empático, comprensivo y ofrece apoyo constructivo.
Nunca des consejos médicos específicos - recomienda consultar a un profesional cuando sea apropiado.', true),
  ('onboarding', 1, 'El usuario está en proceso de onboarding. Preséntate brevemente y pregunta cómo puedes ayudarle hoy.', true)
ON CONFLICT (name, version) DO NOTHING;

-- ============================================================================
-- 5. Experiments - A/B testing infrastructure
-- ============================================================================
CREATE TABLE IF NOT EXISTS experiments (
  key VARCHAR(100) PRIMARY KEY,
  variants JSONB NOT NULL,
  weights JSONB NOT NULL,
  enabled BOOLEAN DEFAULT false,
  description TEXT
);

CREATE TABLE IF NOT EXISTS experiment_assignments (
  user_id UUID NOT NULL,
  experiment_key VARCHAR(100) NOT NULL,
  variant VARCHAR(100) NOT NULL,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, experiment_key)
);

-- ============================================================================
-- 6. AI Usage - Cost tracking for Claude/OpenAI calls
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  correlation_id VARCHAR(64),
  model VARCHAR(100) NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_cents DECIMAL(10, 4),
  latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);

-- ============================================================================
-- 7. Config Templates - Response templates (no credits, errors, etc.)
-- ============================================================================
CREATE TABLE IF NOT EXISTS config_templates (
  key VARCHAR(100) PRIMARY KEY,
  content_es TEXT NOT NULL,
  content_en TEXT,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default templates
INSERT INTO config_templates (key, content_es, content_en, description) VALUES
  ('no_credits', 'Lo siento, no tienes créditos disponibles. Visita nuestra web para obtener más.', 'Sorry, you don''t have any credits available. Visit our website to get more.', 'Sent when user has no credits'),
  ('error', 'Lo siento, ocurrió un error. Por favor intenta de nuevo.', 'Sorry, an error occurred. Please try again.', 'Generic error message'),
  ('maintenance', 'Estamos en mantenimiento. Volvemos pronto.', 'We are under maintenance. We will be back soon.', 'Maintenance mode message'),
  ('crisis_resources', 'Si estás en crisis, por favor contacta a la Línea de la Vida: 800-911-2000. Estamos aquí para ayudarte.', 'If you are in crisis, please contact the Crisis Hotline. We are here to help you.', 'Crisis intervention message')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 8. Config Costs - Credit costs per action
-- ============================================================================
CREATE TABLE IF NOT EXISTS config_costs (
  action VARCHAR(50) PRIMARY KEY,
  credits INTEGER NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default costs
INSERT INTO config_costs (action, credits, description) VALUES
  ('message', 1, 'Standard text message'),
  ('audio', 2, 'Audio message with transcription'),
  ('image', 2, 'Image message'),
  ('premium_response', 3, 'Extended response with analysis')
ON CONFLICT (action) DO NOTHING;

-- ============================================================================
-- 9. Credit Transactions - Track credit usage with idempotency
-- ============================================================================
CREATE TABLE IF NOT EXISTS credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  amount INTEGER NOT NULL,
  action VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL, -- 'reserved', 'confirmed', 'cancelled', 'insufficient'
  idempotency_key VARCHAR(255),
  reference_id VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_tx_idempotency ON credit_transactions(idempotency_key);

-- ============================================================================
-- 10. Conversation State - Track user conversation progress
-- ============================================================================
CREATE TABLE IF NOT EXISTS conversation_state (
  user_id UUID PRIMARY KEY,
  phase VARCHAR(50) NOT NULL DEFAULT 'onboarding',
  onboarding_step INTEGER,
  message_count INTEGER DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  prompt_version VARCHAR(20) DEFAULT 'v1',
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- 11. Messages - Store conversation history
-- ============================================================================
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  conversation_id INTEGER,
  role VARCHAR(20) NOT NULL, -- 'user', 'assistant', 'system'
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- ============================================================================
-- 12. Memories - Store health summaries and other long-term memories
-- ============================================================================
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  content TEXT NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'general', -- 'health_summary', 'general', etc.
  importance_score DECIMAL(3,2) DEFAULT 1.0,
  access_count INTEGER DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(user_id, category);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

-- ============================================================================
-- Cleanup job for old data (run via cron)
-- ============================================================================
-- Delete old execution logs (keep 7 days)
-- DELETE FROM execution_logs WHERE created_at < NOW() - INTERVAL '7 days';

-- Delete old idempotency keys
-- DELETE FROM idempotency_keys WHERE expires_at < NOW();

-- ============================================================================
-- Grant permissions (adjust as needed for your setup)
-- ============================================================================
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vivebien_app;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vivebien_app;
