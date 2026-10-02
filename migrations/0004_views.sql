CREATE TABLE IF NOT EXISTS views (
  day   TEXT NOT NULL,
  kind  TEXT NOT NULL, -- 'clip' | 'page'
  name  TEXT NOT NULL, -- Pfad, z.B. /clips/generated/2026-09-22-TikTok.mp4
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, name)
);
CREATE INDEX IF NOT EXISTS idx_views_day ON views(day);