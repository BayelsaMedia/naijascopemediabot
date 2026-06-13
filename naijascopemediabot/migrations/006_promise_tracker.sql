-- NaijaScope — Promise Tracker persistent storage
-- Safe to run multiple times (idempotent)

CREATE TABLE IF NOT EXISTS promise_tracker (
  id            SERIAL       PRIMARY KEY,
  politician    VARCHAR(200) NOT NULL,
  promise_text  TEXT         NOT NULL,
  date_made     DATE,
  status        VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'KEPT', 'BROKEN')),
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promise_tracker_politician ON promise_tracker (politician);
CREATE INDEX IF NOT EXISTS idx_promise_tracker_status     ON promise_tracker (status);
