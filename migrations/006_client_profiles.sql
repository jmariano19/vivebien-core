-- Migration 006: Client Profiles for Plato Inteligente
-- Adds archetype detection, coaching phase tracking, onboarding state,
-- and Jeff's behavioral notes per client.

CREATE TABLE IF NOT EXISTS client_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Archetype (detected from onboarding answers + refined by behavior)
  archetype VARCHAR(20) NOT NULL DEFAULT 'unknown',
  -- Values: performance, skeptic, curious, passive, unknown

  -- Archetype scores (raw scores from onboarding scoring engine)
  archetype_scores JSONB NOT NULL DEFAULT '{}',
  -- e.g. { "performance": 3, "skeptic": 1, "curious": 2, "passive": 0 }

  -- Coaching phase
  coaching_phase VARCHAR(10) NOT NULL DEFAULT 'phase_1',
  -- phase_1: text insights via WhatsApp (no PDF yet)
  -- phase_2: nightly PDF pending Jeff approval

  -- Onboarding answers (raw text from user, one per question)
  onboarding_answers JSONB NOT NULL DEFAULT '[]',
  -- e.g. [ { "question": 1, "answer": "Quiero entender mi energía" }, ... ]

  -- Confirmed patterns count (graduation trigger: >= 2 → flag for phase_2)
  patterns_confirmed INT NOT NULL DEFAULT 0,

  -- Flag: system detected 2+ patterns, waiting for Jeff to approve phase upgrade
  graduation_pending BOOLEAN NOT NULL DEFAULT FALSE,

  -- When client graduated to phase_2 (null if still in phase_1)
  graduated_at TIMESTAMPTZ,

  -- Jeff's manual notes about this client (free text, updated via dashboard)
  coach_notes TEXT,

  -- Behavioral metadata (updated by pattern detection engine)
  behavioral_data JSONB NOT NULL DEFAULT '{}',
  -- e.g. { "engagement_level": "high", "response_speed": "fast",
  --         "self_initiates": true, "sends_voice": false }

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id)
);

CREATE INDEX idx_client_profiles_user ON client_profiles(user_id);
CREATE INDEX idx_client_profiles_graduation ON client_profiles(graduation_pending) WHERE graduation_pending = TRUE;
CREATE INDEX idx_client_profiles_phase ON client_profiles(coaching_phase);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_client_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER client_profiles_updated_at
  BEFORE UPDATE ON client_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_client_profiles_updated_at();
