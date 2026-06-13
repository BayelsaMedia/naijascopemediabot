-- NaijaScope — Module B (Search) + Module C (Stats)
-- Safe to run multiple times (all statements are idempotent)

-- ── Search history (per-user last 5 unique searches) ─────────────────────────
CREATE TABLE IF NOT EXISTS search_history (
  id              SERIAL       PRIMARY KEY,
  whatsapp_number VARCHAR(20)  NOT NULL REFERENCES users(whatsapp_number) ON DELETE CASCADE,
  keyword         VARCHAR(100) NOT NULL,
  result_count    INT          NOT NULL DEFAULT 0,
  searched_at     TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (whatsapp_number, keyword)
);

CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history (whatsapp_number, searched_at DESC);

-- ── Search analytics (aggregate keyword tracking) ────────────────────────────
CREATE TABLE IF NOT EXISTS search_analytics (
  id              SERIAL       PRIMARY KEY,
  whatsapp_number TEXT         NOT NULL,
  keyword         VARCHAR(100) NOT NULL,
  result_count    INT          NOT NULL DEFAULT 0,
  searched_at     TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_search_analytics_keyword ON search_analytics (keyword, searched_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_analytics_date    ON search_analytics (searched_at DESC);

-- ── Security event log ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS security_events (
  id                   SERIAL       PRIMARY KEY,
  whatsapp_number      TEXT         NOT NULL,
  event_type           TEXT         NOT NULL, -- 'impersonation', 'injection', 'harmful', 'admin_probe'
  message_preview      TEXT,
  suspension_expires_at TIMESTAMPTZ,
  detected_at          TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events (event_type, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events (whatsapp_number, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_date ON security_events (detected_at DESC);

-- ── Bot health metrics (5-minute snapshots) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS health_metrics (
  id                      SERIAL       PRIMARY KEY,
  recorded_at             TIMESTAMPTZ  DEFAULT NOW(),
  avg_response_ms         INT,
  grok_success_count      INT          NOT NULL DEFAULT 0,
  grok_failure_count      INT          NOT NULL DEFAULT 0,
  wa_api_error_count      INT          NOT NULL DEFAULT 0,
  webhook_event_count     INT          NOT NULL DEFAULT 0,
  duplicate_blocked_count INT          NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_health_metrics_date ON health_metrics (recorded_at DESC);
