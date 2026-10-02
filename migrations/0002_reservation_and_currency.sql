-- Reservierung: welcher Kauf versucht, welchen Pixel zu sichern.
-- Ein eindeutiger Index auf purchases.pixel_id verhindert, dass zwei
-- parallele Checkouts denselben Pixel reservieren (Doppelkauf-Race).
ALTER TABLE purchases ADD COLUMN pixel_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_pixel_id ON purchases(pixel_id);

-- Herkunfts-IP fuer ein einfaches Rate-Limit pro IP.
ALTER TABLE purchases ADD COLUMN ip TEXT;
CREATE INDEX IF NOT EXISTS idx_purchases_created ON purchases(created_at);