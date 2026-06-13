-- NaijaScope — Module A: Admin Broadcast Dashboard
-- Safe to run multiple times (all statements are idempotent)

-- ── System configuration (persistent key/value store) ─────────────────────────
CREATE TABLE IF NOT EXISTS system_config (
  key        VARCHAR(100) PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ  DEFAULT NOW()
);

-- Seed default breaking-mode state rows so they always exist
INSERT INTO system_config (key, value) VALUES ('breaking_mode_active', 'false')       ON CONFLICT (key) DO NOTHING;
INSERT INTO system_config (key, value) VALUES ('breaking_mode_topic', '')              ON CONFLICT (key) DO NOTHING;
INSERT INTO system_config (key, value) VALUES ('breaking_mode_activated_at', '')       ON CONFLICT (key) DO NOTHING;
INSERT INTO system_config (key, value) VALUES ('breaking_mode_expires_at', '')         ON CONFLICT (key) DO NOTHING;
INSERT INTO system_config (key, value) VALUES ('breaking_mode_activated_by', '')       ON CONFLICT (key) DO NOTHING;

-- ── Broadcast log (every broadcast attempt, including scheduled) ───────────────
CREATE TABLE IF NOT EXISTS broadcast_log (
  id                    SERIAL       PRIMARY KEY,
  message_body          TEXT         NOT NULL,
  broadcast_type        VARCHAR(20)  NOT NULL CHECK (broadcast_type IN ('instant','scheduled','segment')),
  segment               VARCHAR(20)  NOT NULL DEFAULT 'all' CHECK (segment IN ('all','last_7d','last_30d')),
  scheduled_at          TIMESTAMPTZ,
  sent_at               TIMESTAMPTZ,
  total_recipients      INT          NOT NULL DEFAULT 0,
  successful_deliveries INT          NOT NULL DEFAULT 0,
  failed_deliveries     INT          NOT NULL DEFAULT 0,
  resume_from_index     INT          NOT NULL DEFAULT 0,
  admin_phone_hash      VARCHAR(64),
  status                VARCHAR(20)  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','cancelled')),
  created_at            TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broadcast_log_status    ON broadcast_log (status);
CREATE INDEX IF NOT EXISTS idx_broadcast_log_scheduled ON broadcast_log (scheduled_at) WHERE status = 'pending';

-- ── Admin audit log ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          SERIAL       PRIMARY KEY,
  phone_hash  VARCHAR(64)  NOT NULL,
  command     TEXT         NOT NULL,
  outcome     VARCHAR(50)  NOT NULL,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_hash ON admin_audit_log (phone_hash, created_at DESC);

-- ── Probe attempts log (non-admins attempting admin commands) ─────────────────
CREATE TABLE IF NOT EXISTS admin_probe_log (
  id          SERIAL       PRIMARY KEY,
  from_hash   VARCHAR(64)  NOT NULL,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_probe_log_hash ON admin_probe_log (from_hash, created_at DESC);
