-- Migration 007: Nightly Summaries — Pending Approval Queue
--
-- Stores rendered HTML summaries waiting for Jeff's approval.
-- Flow: digest generated → HTML saved here (status=pending)
--       → Jeff approves in dashboard → PDF sent via WhatsApp (status=sent)

CREATE TABLE IF NOT EXISTS nightly_summaries (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest_id     UUID         REFERENCES daily_digests(id) ON DELETE SET NULL,
  html_content  TEXT         NOT NULL,
  digest_data   JSONB        NOT NULL DEFAULT '{}',
  status        VARCHAR(20)  NOT NULL DEFAULT 'pending',  -- pending | approved | sent | discarded
  digest_date   DATE         NOT NULL,
  approved_at   TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT nightly_summaries_user_date_unique UNIQUE (user_id, digest_date),
  CONSTRAINT nightly_summaries_status_check CHECK (status IN ('pending', 'approved', 'sent', 'discarded'))
);

CREATE INDEX IF NOT EXISTS idx_nightly_summaries_user_id  ON nightly_summaries(user_id);
CREATE INDEX IF NOT EXISTS idx_nightly_summaries_status    ON nightly_summaries(status);
CREATE INDEX IF NOT EXISTS idx_nightly_summaries_date      ON nightly_summaries(digest_date DESC);
