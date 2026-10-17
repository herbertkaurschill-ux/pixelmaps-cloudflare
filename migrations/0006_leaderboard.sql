-- Leaderboard: Land je Pixel speichern (fuer "Laender-Rennen").
-- Wird beim Kauf in completePaidSession gesetzt (Reverse-Geocoding).
-- Bestandsdaten bleiben NULL und werden im Leaderboard ignoriert.
ALTER TABLE pixels ADD COLUMN country TEXT;

CREATE INDEX IF NOT EXISTS idx_pixels_country ON pixels(country);
