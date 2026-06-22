-- ============================================================
-- Supabase schema for Розклад Студента (mpmek.site)
-- Replaces Redis (Upstash) as primary data store
-- ============================================================

-- ── Users ──
CREATE TABLE IF NOT EXISTS users (
  username      TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  salt          TEXT,
  "group"       TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user',   -- user | starosta | teacher | admin
  teacher_name  TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- ── Sessions ──
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  username    TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  session_ver TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- ── Session versions (for mass-invalidation) ──
CREATE TABLE IF NOT EXISTS session_versions (
  username    TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
  version     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);
ALTER TABLE session_versions ENABLE ROW LEVEL SECURITY;

-- ── WebAuthn credentials ──
CREATE TABLE IF NOT EXISTS webauthn_creds (
  username    TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  creds_json  JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (username)
);
ALTER TABLE webauthn_creds ENABLE ROW LEVEL SECURITY;

-- ── WebAuthn challenges (short-lived) ──
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  username    TEXT PRIMARY KEY,
  challenge   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);
ALTER TABLE webauthn_challenges ENABLE ROW LEVEL SECURITY;

-- ── Schedule (JSON blob per group) ──
CREATE TABLE IF NOT EXISTS schedule (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE schedule ENABLE ROW LEVEL SECURITY;

-- ── Homework (text entries) ──
CREATE TABLE IF NOT EXISTS homework_text (
  group_name  TEXT NOT NULL,
  day         TEXT NOT NULL,
  number      INTEGER NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (group_name, day, number)
);
ALTER TABLE homework_text ENABLE ROW LEVEL SECURITY;

-- ── Homework attachments ──
CREATE TABLE IF NOT EXISTS homework_attachments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_name  TEXT NOT NULL,
  day         TEXT NOT NULL,
  number      INTEGER NOT NULL,
  url         TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
  size        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hw_att_lookup ON homework_attachments(group_name, day, number);
ALTER TABLE homework_attachments ENABLE ROW LEVEL SECURITY;

-- ── Push subscriptions ──
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id                TEXT PRIMARY KEY,
  subscription_enc  TEXT,       -- encrypted payload (AES-256-GCM)
  subscription_raw  JSONB,     -- fallback if no encryption key
  "group"           TEXT NOT NULL DEFAULT '',
  notify_time       TEXT NOT NULL DEFAULT '08:00',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- ── Rate limits ──
CREATE TABLE IF NOT EXISTS rate_limits (
  key         TEXT PRIMARY KEY,
  count       INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL
);
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- ── Audit log ──
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  username    TEXT NOT NULL DEFAULT 'unknown',
  ip          TEXT NOT NULL DEFAULT 'unknown',
  action      TEXT NOT NULL,
  detail      TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- ── Login log ──
CREATE TABLE IF NOT EXISTS login_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  username    TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'user',
  ip          TEXT NOT NULL DEFAULT 'unknown',
  success     BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_login_ts ON login_log(ts DESC);
ALTER TABLE login_log ENABLE ROW LEVEL SECURITY;

-- ── CSP reports ──
CREATE TABLE IF NOT EXISTS csp_reports (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  url         TEXT DEFAULT '',
  violated    TEXT DEFAULT '',
  blocked     TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_csp_ts ON csp_reports(ts DESC);
ALTER TABLE csp_reports ENABLE ROW LEVEL SECURITY;

-- ── Bot users (synced from Telegram bot) ──
CREATE TABLE IF NOT EXISTS bot_users (
  chat_id     TEXT PRIMARY KEY,
  name        TEXT DEFAULT '',
  "group"     TEXT DEFAULT '',
  notify_time TEXT DEFAULT '07:30',
  active      BOOLEAN NOT NULL DEFAULT true,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE bot_users ENABLE ROW LEVEL SECURITY;

-- ── Telegram subscriptions (bot users per group) ──
CREATE TABLE IF NOT EXISTS tg_subscriptions (
  chat_id     TEXT NOT NULL,
  group_name  TEXT NOT NULL,
  PRIMARY KEY (chat_id, group_name)
);
CREATE INDEX IF NOT EXISTS idx_tg_subs_group ON tg_subscriptions(group_name);
ALTER TABLE tg_subscriptions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Rate-limit check function (atomic increment + expiry)
-- Returns TRUE if rate-limited (over the limit)
-- ============================================================
CREATE OR REPLACE FUNCTION rl_check(p_key TEXT, p_limit INTEGER, p_window_sec INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
  v_expires TIMESTAMPTZ;
BEGIN
  SELECT count, expires_at INTO v_count, v_expires
  FROM rate_limits WHERE key = p_key FOR UPDATE;

  IF NOT FOUND OR v_expires < now() THEN
    INSERT INTO rate_limits (key, count, expires_at)
    VALUES (p_key, 1, now() + (p_window_sec || ' seconds')::interval)
    ON CONFLICT (key) DO UPDATE SET count = 1, expires_at = now() + (p_window_sec || ' seconds')::interval;
    RETURN FALSE;
  END IF;

  IF v_count >= p_limit THEN
    RETURN TRUE;
  END IF;

  UPDATE rate_limits SET count = count + 1 WHERE key = p_key;
  RETURN FALSE;
END;
$$;
