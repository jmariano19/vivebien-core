-- Migration 005: health_events table for Plato Inteligente
-- Flexible health event tracking — stores raw inputs during the day,
-- nightly AI processes and fills structured extraction.

CREATE TABLE IF NOT EXISTS health_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),

  -- Classification (NULL at creation, filled by nightly AI)
  event_type VARCHAR(30),
  -- Values: meal, symptom, lab_result, medication, digestion, sleep, exercise, mood, general

  -- When
  event_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_date DATE NOT NULL DEFAULT CURRENT_DATE,

  -- What the user said/sent (RAW — saved immediately, no AI needed)
  raw_input TEXT,
  image_url TEXT,

  -- Structured extraction (FILLED BY NIGHTLY AI, not at creation)
  extracted_data JSONB NOT NULL DEFAULT '{}',

  -- Message type
  is_question BOOLEAN NOT NULL DEFAULT FALSE,

  -- Processing status
  processed BOOLEAN NOT NULL DEFAULT FALSE,

  -- Metadata
  source VARCHAR(20) DEFAULT 'whatsapp',
  language VARCHAR(5),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookups for nightly summary (all events for a user on a date)
CREATE INDEX IF NOT EXISTS idx_health_events_user_date
  ON health_events(user_id, event_date);

-- Fast lookup for unprocessed events (nightly batch picks these up)
CREATE INDEX IF NOT EXISTS idx_health_events_unprocessed
  ON health_events(user_id, processed)
  WHERE processed = FALSE;

-- For weekly queries
CREATE INDEX IF NOT EXISTS idx_health_events_user_type
  ON health_events(user_id, event_type)
  WHERE event_type IS NOT NULL;
