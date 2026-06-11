-- NaijaScope Media Bot — Initial Schema
-- Safe to run multiple times (all statements are idempotent)

-- ── Users ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  whatsapp_number   VARCHAR(20) PRIMARY KEY,
  language_pref     VARCHAR(10)  DEFAULT 'en',
  subscription_status BOOLEAN   DEFAULT FALSE,
  digest_enabled    BOOLEAN      DEFAULT FALSE,
  breaking_alerts   BOOLEAN      DEFAULT FALSE,
  favorite_team     VARCHAR(100),
  location_state    VARCHAR(100),
  location_lga      VARCHAR(100),
  resume_context    TEXT,
  created_at        TIMESTAMPTZ  DEFAULT NOW(),
  last_seen         TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users (last_seen);

-- ── Subscriptions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id                SERIAL PRIMARY KEY,
  whatsapp_number   VARCHAR(20)  NOT NULL REFERENCES users(whatsapp_number) ON DELETE CASCADE,
  subscription_type VARCHAR(50)  NOT NULL,
  subscription_value VARCHAR(100) NOT NULL,
  created_at        TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (whatsapp_number, subscription_type, subscription_value)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_type ON user_subscriptions (subscription_type);

-- ── Saved articles ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saved_articles (
  id              SERIAL PRIMARY KEY,
  whatsapp_number VARCHAR(20)   NOT NULL REFERENCES users(whatsapp_number) ON DELETE CASCADE,
  article_id      VARCHAR(500)  NOT NULL,
  article_title   TEXT,
  article_url     TEXT,
  saved_at        TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (whatsapp_number, article_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_articles_user ON saved_articles (whatsapp_number, saved_at DESC);

-- ── Support tickets ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_tickets (
  id              SERIAL PRIMARY KEY,
  reference_code  VARCHAR(20)  UNIQUE NOT NULL,
  whatsapp_number VARCHAR(20)  NOT NULL,
  issue           TEXT,
  status          VARCHAR(20)  DEFAULT 'open',
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  closed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_status ON support_tickets (whatsapp_number, status);

-- ── Keyword alerts ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_keyword_alerts (
  id              SERIAL PRIMARY KEY,
  whatsapp_number VARCHAR(20)  NOT NULL REFERENCES users(whatsapp_number) ON DELETE CASCADE,
  keyword         VARCHAR(100) NOT NULL,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (whatsapp_number, keyword)
);

CREATE INDEX IF NOT EXISTS idx_keyword_alerts_user ON user_keyword_alerts (whatsapp_number);
