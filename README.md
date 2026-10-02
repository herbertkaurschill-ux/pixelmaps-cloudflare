# PixelMaps — Cloudflare starter

This is a production-oriented starter for a geographic 1,000,000,000-pixel project.

## Architecture
- Cloudflare Worker: API + Stripe webhook
- Cloudflare D1: only sold pixels, purchases and certificates are stored
- Static frontend served through Workers Assets
- Deterministic geographic grid: 40,000 columns × 25,000 rows = 1,000,000,000 cells
- Pixel ID is stable and maps to a geographic center point

## Deploy

1. Install Node.js.
2. Run `npm install`.
3. Create a D1 database:
   `npx wrangler d1 create pixelmaps`
4. Put the returned database ID into `wrangler.toml`.
5. Initialize:
   `npm run db:remote`
   `npx wrangler d1 execute pixelmaps --file=migrations/0002_reservation_and_currency.sql --remote`
   `npx wrangler d1 execute pixelmaps --file=migrations/0003_consent.sql --remote`
6. Set Stripe secrets:
   `npx wrangler secret put STRIPE_SECRET_KEY`
   `npx wrangler secret put STRIPE_WEBHOOK_SECRET`
   `npx wrangler secret put RESEND_API_KEY`
   `npx wrangler secret put RESEND_FROM_EMAIL`
7. In Stripe, create a webhook endpoint:
   `https://pixelmaps.org/api/stripe-webhook`
   Subscribe to `checkout.session.completed`.
8. `npm run deploy` (custom domain `pixelmaps.org` is declared in `wrangler.toml`; first-time deploy needs `npx wrangler login`)

## Go-Live-Checkliste

- [ ] Remote-Migrationen 0002 + 0003 ausgeführt (Schritt 5)
- [ ] Produktiv-Secrets gesetzt (Schritt 6, Live-Keys, nicht `sk_test_`)
- [ ] Stripe-Live-Webhook angelegt, `whsec_…` in `STRIPE_WEBHOOK_SECRET`
- [ ] `npm run deploy` mit Custom Domain (DNS der Zone liegt bei Cloudflare; Workers-Custom-Domain übernimmt die Bereitstellung)
- [ ] Zustellungstest an `kontakt@pixelmaps.org` / `datenschutz@pixelmaps.org` (ImprovMX-Weiterleitung nach herbertkaurschill@gmail.com)
- [ ] Absender der Urkunde via Resend getestet; Domain ist verifiziert (DKIM `resend._domainkey`, Tracking-CNAMEs vorhanden)
- [ ] SPF für Empfang+Senden zusammengeführt:
     `v=spf1 include:spf.improvmx.com include:_spf.resend.com ~all` (bereits per API gesetzt)
- [ ] DMARC (bereits vorhanden via Cloudflare DMARC Management, `p=none`; später auf `p=quarantine` verschärfen)
- [ ] `FX_RATES` mit aktuellen Kursen setzen (sonst Platzhalterkurse für Fremdwährungen)
- [ ] API-Token aus Chatverlauf löschen/rotieren
- [ ] Probezahlung in Live-Umgebung (z.B. 1 €) inkl. Zertifikat-PDF + E-Mail

## Important before accepting real money

This starter is intentionally compact. Before public launch, add:
- verified Stripe webhook processing and idempotency records
- GDPR/privacy/legal pages and consent flows
- email delivery for receipts/certificates
- rate limiting / bot protection
- CSRF/origin checks where appropriate
- admin authentication
- image/logo moderation if user uploads are added
- a real basemap / land-sea geometry (the demo canvas has a stylized backdrop)
- local-currency display if desired. The actual Stripe charge is EUR in this starter.
- certificate PDF generation (can be added with R2 and a PDF service/runtime)
- refund/revocation policy
- fraud and duplicate-payment handling
- proper reservation/hold logic if you need to lock a pixel during checkout

## Datenschutz / DSGVO (vor Start prüfen)

- `public/impressum.html`, `public/datenschutz.html`, `public/agb.html` sind ausgefüllt (Betreiber: Peter Schmidt, Immermannstraße 20, 40210 Düsseldorf; Kontakt: +49 1623579769, kontakt@/datenschutz@pixelmaps.org).
- Der Checkout verlangt eine dokumentierte Einwilligung (Art. 6 Abs. 1 lit. a DSGVO) für die öffentliche Anzeige von Anzeigename/Webseite/Nachricht (`purchases.consent_given`, `consent_at`). Ohne Einwilligung wird der Pixel anonym dargestellt.
- Öffentliche APIs geben personenbezogene Felder nur bei Einwilligung aus.
- Zertifikate (PDF mit Anzeigename) sind nur mit Kauf-Nachweis (Token aus dem Checkout) oder der Zertifikatsnummer abrufbar.
- Bestehende Käufe vor Einführung der Einwilligung (`consent_given=0`) werden anonym dargestellt. Für deren öffentliche Anzeige muss jeder Inhaber nachträglich gefragt werden (`UPDATE purchases SET consent_given=1, consent_at=CURRENT_TIMESTAMP WHERE id='…'`).

## Geographic note

A geographic "pixel" here is a cell in an equirectangular global grid. Cells are not equal physical area: they become narrower east-west toward the poles. If the product promise requires equal-area pixels, replace the grid with an equal-area projection and define exactly how ocean/land cells are handled.

The phrase "world record" should only be used as an official record claim if the relevant record organization has actually recognized it.
