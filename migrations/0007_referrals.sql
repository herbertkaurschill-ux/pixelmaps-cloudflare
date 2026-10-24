-- Referral-Programm: "Freund einladen – Pixel gratis".
-- Jeder bezahlte Kauf erzeugt einen teilbaren Code. Kauft jemand ueber diesen
-- Code, bekommt der Besitzer 1 Gratis-Pixel-Guthaben. Das Guthaben loest der
-- Besitzer beim eigenen (Neu-)Kauf ueber einen 100%-Stripe-Coupon ein.

-- Auf dem Kauf: welcher Code hat mich geworben (ref_code), welcher Code wurde
-- zum Einloesen eines Gratis-Pixels benutzt (claim_code) und ob eingeloest
-- (use_credit). referral_credited markiert, dass die Gutschrift verarbeitet ist.
ALTER TABLE purchases ADD COLUMN ref_code TEXT;
ALTER TABLE purchases ADD COLUMN claim_code TEXT;
ALTER TABLE purchases ADD COLUMN use_credit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN referral_credited INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS referrals (
  code TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL UNIQUE,
  credits INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_referrals_purchase ON referrals(purchase_id);
