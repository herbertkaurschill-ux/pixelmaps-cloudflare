-- Datenschutz: Einwilligung fuer die oeffentliche Anzeige von
-- Anzeigename / Webseite / Nachricht auf der Karte (Art. 6 Abs. 1 lit. a DSGVO).
ALTER TABLE purchases ADD COLUMN consent_given INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN consent_at TEXT;