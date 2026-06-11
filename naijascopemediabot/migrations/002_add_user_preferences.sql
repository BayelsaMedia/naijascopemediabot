-- NaijaScope — User Preferences & Interaction Tracking
-- Safe to run multiple times (idempotent)

ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_interest  VARCHAR(30);
ALTER TABLE users ADD COLUMN IF NOT EXISTS msg_count        INT NOT NULL DEFAULT 0;

-- Per-user category read counts — used for adaptive menu ordering
CREATE TABLE IF NOT EXISTS user_category_counts (
  whatsapp_number  VARCHAR(20)  NOT NULL REFERENCES users(whatsapp_number) ON DELETE CASCADE,
  category         VARCHAR(30)  NOT NULL,
  count            INT          NOT NULL DEFAULT 0,
  last_read        TIMESTAMPTZ  DEFAULT NOW(),
  PRIMARY KEY (whatsapp_number, category)
);

CREATE INDEX IF NOT EXISTS idx_category_counts_user ON user_category_counts (whatsapp_number, count DESC);
