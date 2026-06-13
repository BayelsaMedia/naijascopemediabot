-- NaijaScope — User opt-out support
-- Safe to run multiple times (idempotent)

ALTER TABLE users ADD COLUMN IF NOT EXISTS opted_out      BOOLEAN     NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS opted_out_at   TIMESTAMPTZ;
