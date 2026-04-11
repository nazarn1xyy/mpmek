-- ============================================
-- Supabase Schema for mpmek.site
-- Run this in Supabase SQL Editor (one time)
-- ============================================

-- Групи
CREATE TABLE groups (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  sort_order INT DEFAULT 0
);

-- Розклад (основний, чисельник, знаменник)
CREATE TABLE schedules (
  id SERIAL PRIMARY KEY,
  group_id INT REFERENCES groups(id) ON DELETE CASCADE,
  week_type TEXT NOT NULL DEFAULT 'ОСНОВНИЙ РОЗКЛАД',
  day TEXT NOT NULL,
  number INT NOT NULL,
  subject TEXT NOT NULL,
  teacher TEXT DEFAULT '',
  UNIQUE(group_id, week_type, day, number)
);

-- Підвіски (заміни)
CREATE TABLE substitutions (
  id SERIAL PRIMARY KEY,
  group_id INT REFERENCES groups(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  number INT NOT NULL,
  subject TEXT NOT NULL,
  teacher TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, date, number)
);

-- Домашні завдання
CREATE TABLE homework (
  id SERIAL PRIMARY KEY,
  group_id INT REFERENCES groups(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  number INT NOT NULL,
  text TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, day, number)
);

-- Web Push підписки
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  keys JSONB NOT NULL,
  group_name TEXT NOT NULL,
  notify_time TEXT DEFAULT '08:00',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Telegram підписники
CREATE TABLE tg_subscribers (
  id SERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(chat_id, group_name)
);

-- Налаштування (розклад дзвінків, admin config тощо)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- ============================================
-- Індекси
-- ============================================
CREATE INDEX idx_schedules_group ON schedules(group_id);
CREATE INDEX idx_schedules_group_type ON schedules(group_id, week_type);
CREATE INDEX idx_substitutions_group_date ON substitutions(group_id, date);
CREATE INDEX idx_homework_group ON homework(group_id);
CREATE INDEX idx_tg_subs_group ON tg_subscribers(group_name);
CREATE INDEX idx_push_subs_group ON push_subscriptions(group_name);

-- ============================================
-- Insert default lesson times
-- ============================================
INSERT INTO settings (key, value) VALUES (
  'lessonTimes',
  '{"1": "08:30 - 09:50", "2": "10:00 - 11:20", "3": "11:50 - 13:10", "4": "13:20 - 14:40", "5": "14:50 - 16:10", "6": "16:20 - 17:40"}'::jsonb
);
