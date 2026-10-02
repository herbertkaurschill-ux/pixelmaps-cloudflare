PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  stripe_session_id TEXT UNIQUE,
  email TEXT,
  display_name TEXT,
  website TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  currency TEXT NOT NULL DEFAULT 'eur',
  amount_minor INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS pixels (
  pixel_id INTEGER PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  purchase_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  website TEXT,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (purchase_id) REFERENCES purchases(id)
);

CREATE INDEX IF NOT EXISTS idx_pixels_lat_lon ON pixels(lat, lon);
CREATE INDEX IF NOT EXISTS idx_pixels_created_at ON pixels(created_at);

CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
  pixel_id INTEGER NOT NULL UNIQUE,
  certificate_no TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pixel_id) REFERENCES pixels(pixel_id)
);

CREATE TABLE IF NOT EXISTS reservations (
  pixel_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  purchase_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reservations_expires ON reservations(expires_at);
