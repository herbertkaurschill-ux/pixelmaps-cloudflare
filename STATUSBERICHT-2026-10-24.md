# Zustandsbericht PixelMaps – 24. Oktober 2026

**Erhebung:** 24.10.2026, ca. 16:16 Uhr lokal (14:16 UTC)
**Grundlage:** Live-Abfragen gegen `https://pixelmaps.org`, `wrangler deployments list`, Git-Stand, Dateizeitstempel der Tagesclips.
**Vorgänger:** [BERICHT.md](BERICHT.md) (21.10.2026) – dieser Bericht ersetzt ihn als aktuellen Stand, nicht als Historie.

---

## 1. Kurzfazit

| Bereich | Zustand |
|---|---|
| Produktivbetrieb | 🟢 läuft, letzter Deploy **heute 07:10 UTC** (Version `f6b86b05…`) |
| Verkauf | 🔴 **0 echte Verkäufe**, 0 € Umsatz in 24 h |
| Tagespipeline (Clips) | 🟢 Clips für 21.–24.10. erzeugt, heutige Assets live erreichbar |
| Buffer-Push | 🟡 **nicht verifizierbar** – API meldet 24-h-Rate-Limit |
| Tracking/Funnel | 🔴 praktisch keine Daten (nur Test-Events der letzten 7 Tage) |
| Referral-Programm | 🟢 implementiert und live erreichbar, in Prod aber noch unbenutzt |
| Repo-Hygiene | 🔴 gesamter Oktober-Fortschritt uncommittet, Secrets im Klartext |

Der Betrieb läuft technisch, aber es gibt **keinen messbaren Verkauf und kein belastbares Funnel-Tracking**. Größte unmittelbare Risiken: offenliegende API-Keys und der fehlende Commit-Stand.

---

## 2. Produktivsystem

- **Seite:** `https://pixelmaps.org/` → HTTP 200, 100.675 Bytes, Antwortzeit ~0,1 s.
- **Worker:** `pixelmaps`, letzter Deploy **24.10.2026 07:10:54 UTC**, Version `f6b86b05-e334-40f7-aceb-b9df75f3bf20`, 100 % Traffic.
- **Deploy-Historie (10 Deploys):** 18.10., 19.10., 20.10., 21.10. (4×), 22.10., 24.10. → **am 23.10. kein Deploy**, der heutige Lauf war der erste seit dem 22.10. 07:58 UTC.
- **Assets/SEO:**
  - `/robots.txt` 200 (`Disallow: /api/`, Sitemap verlinkt)
  - `/sitemap.xml` 200 (10.151 Bytes)
  - `/pixel-berlin`, `/pixel-new-york` 200
  - Rechtstexte: `/impressum.html`, `/datenschutz.html`, `/agb.html` leiten per 307 auf `/impressum`, `/datenschutz`, `/agb` (alle 200) – funktioniert, ist aber ein zusätzlicher Redirect pro Aufruf.
- **Tagesclips 24.10. live:** TikTok/Reel `200` (720.789 B), Instagram-Poster `200` (142.534 B).

---

## 3. Verkauf und Funnel

| Kennzahl | Wert (24.10., 14:16 UTC) |
|---|---|
| Verkaufte Pixel (`/api/stats`) | **0** von 1.000.000.000 |
| Pixel-Datensätze gesamt (`/api/health`) | 14 (Testkäufe) |
| Zahlungen letzte 24 h | 0 |
| Umsatz letzte 24 h | 0 Cent |
| Alte offene Checkout-Sessions | **5** (`pendingOld`) |
| Abgelaufene Reservierungen 24 h | 0 |
| Seitenaufrufe gestern | 126 |
| Clip-Aufrufe gestern | 61 |
| Events letzte 7 Tage | ausschließlich Testdaten (`__selftest__`, je 1× `page_view` / `checkout_open`) |

**Bewertung:** Die Verkaufszahlen sind ehrlich (0), aber das Funnel-Tracking ist derzeit wertlos – es kommen keine echten Events an. Damit ist keine Aussage darüber möglich, wo Interessenten abspringen. Die 5 verwaisten Checkout-Sessions sollten aufgeräumt werden (Health meldet sie seit Tagen).

Datensparsamkeit funktioniert: `/api/pixels` und `/api/recent` liefern Anzeigenamen nur als `null`, solange keine Einwilligung vorliegt.

---

## 4. Content-Pipeline

- **Tagesclips vorhanden:** 21., 22., 23. und 24.10. – je 4 Dateien (TikTok, YouTubeShorts, InstagramReel, Instagram-Poster), Erzeugung jeweils zwischen 09:10 und 10:10 Uhr lokal.
- **Lücke:** 06.10.–20.10. keine Clips (Altbestand endet am 05.10.) – Folge des damaligen TCC-/launchd-Problems. Seit 21.10. läuft die Kette wieder.
- **Heutiger Lauf:** Der Deploy um 07:10 UTC belegt, dass `publish-day.sh` heute mindestens bis zum Deploy durchgelaufen ist.
- **Buffer-Queue:** ❌ nicht prüfbar. Die GraphQL-API antwortet aktuell mit
  `RATE_LIMIT_EXCEEDED`, Fenster **24 h**. Ob heute die 3 frischen Posts geplant wurden und wie voll die Queues (Ziel 7/7/7) sind, konnte ich daher nicht verifizieren.
- **Orchestrator:** letzter Output `scripts/agent/orchestrator-out.json` von **23.10., 20:18 UTC** (3 Ideen, 3 Gewinner, 6 Sprachen). Für den 24.10. existiert noch kein neuer Output. Da der Orchestrator in `publish-day.sh` **nach** dem Buffer-Push läuft, ist ein Abbruch durch das API-Limit plausibel – bestätigen lässt sich das nur über das Log außerhalb des Projekts (`~/.n8n/content/review/publish-day.log`), das ich nicht gelesen habe.

**Betriebsrisiko:** Queue-Auslesen, Trimmen, Agent-Push und Auffüllen teilen sich dasselbe Tageslimit der Buffer-API. Ein einziger Diagnose-Aufruf kann die Tagespipeline für 24 h blockieren.

---

## 5. Referral-Programm

- **Code:** `migrations/0007_referrals.sql`, Worker-Endpoints (`/api/referral`, Gutschrift/Verbrauch im Checkout) und Frontend (Banner, Box, „Gratis-Pixel einlösen“).
- **Schema:** heilt sich selbst (`CREATE TABLE IF NOT EXISTS`, `safeAlter` für `purchases.referral_credited`).
- **Logik:** Empfehlungscode pro Kauf, 20 % Coupon `pm-ref20`, Gratis-Pixel-Coupon `pm-freepixel` (100 %), Gutschrift idempotent über `referral_credited`.
- **Live-Status:** `/api/referral` → 200 mit `{"found":false,"code":"","credits":0,"uses":0}` – erreichbar, aber es existiert noch kein produktiver Code, also auch noch keine echte Nutzung.
- **Test:** laut BERICHT 13/13 im lokalen E2E; in Produktion bisher nicht durchgespielt.

---

## 6. Repository-Stand

- **Branch:** `main`, letzter Commit `f7b6dde` vom 17.10.2026 („Safety snapshot: honest counter, share loop, city SEO pages, country leaderboard“), insgesamt 3 Commits.
- **Modifiziert (6 Dateien, +434 / −60):** `public/index.html`, `src/worker.js` (+212 Zeilen, im Wesentlichen Referral), `scripts/campaign/topup.mjs`, `scripts/fill-queue.cjs`, `scripts/publish-day.sh`, `scripts/campaign/.topup-state.json`.
- **Neu/untracked:** `BERICHT.md`, `agent-backup.js` (35 KB, Sicherungskopie des Content-Agenten), `migrations/0007_referrals.sql`, 16 Clip-Dateien (21.–24.10.), `public/robots.txt`, `scripts/agent/` (config, orchestrator, orchestrator-push, out), `scripts/orchestrator.js`, `scripts/orchestrator-out.json`, `scripts/buffer-queue.cjs`, `scripts/campaign/{clip-index.cjs,repair-posts.mjs}`.

**Konsequenz:** Der komplette Oktober-Fortschritt (Referral, Pipeline-Fixes, Clips) ist **nicht committet**. Deploys laufen aus dem Working Tree; es gibt keinen Rollback-Punkt für den aktuellen Produktivstand.

---

## 7. Risiken

1. **Secrets im Klartext (hoch):**
   - `scripts/agent/config.json` enthält Buffer-Token, Pollinations-Key, Gemini-Key und Moderations-Key (seit 24.10. in `.gitignore`, Vorlage: `scripts/agent/config.example.json`).
   - `SUMMARY.md` enthielt ein **Live-Stripe-Webhook-Secret** im Klartext; der Wert ist entfernt, steht aber weiterhin in der Git-Historie → Rotation nötig.
2. **Kein Commit-Stand (hoch):** s. o., kein sauberer Rollback möglich.
3. **Buffer-Tageslimit (mittel):** Diagnose und Betrieb konkurrieren um dasselbe Kontingent; die Pipeline ist dadurch fragil.
4. **Totes Tracking (mittel):** ohne Events keine Conversion-Optimierung, jede Traffic-Maßnahme bleibt blind.
5. **5 verwaiste Checkout-Sessions (niedrig):** verfälschen Health und Buchhaltung.
6. **Letzter Deploy nur durch Cron:** Code-Änderungen seit dem 22.10. sind erst mit dem heutigen Cron-Deploy live gegangen – kein bewusster Release-Zeitpunkt.

---

## 8. Empfohlene nächste Schritte (priorisiert)

1. **Secrets bereinigen:** `.gitignore` um `scripts/agent/` und `.dev.vars`-artige Dateien ergänzen, Keys rotieren (Buffer, Pollinations, Gemini, Moderation, Stripe-Webhook) und `SUMMARY.md` von Klartext-Secrets befreien.
2. **Aktuellen Stand committen** (nach Schritt 1), damit ein Rollback-Punkt existiert.
3. **Buffer-Zustand nach Ablauf des 24-h-Fensters prüfen:** Sind die 3 Tagesposts drin, wie voll sind die Queues? Danach Abfragen im Cron drosseln (z. B. Status lokal cachen, nur 1×/Tag abfragen).
4. **Tracking reparieren:** prüfen, warum seit Tagen keine echten `page_view`/`checkout_open`-Events ankommen.
5. **Pending-Sessions aufräumen** und Health-Schwelle wieder auf 0 bringen.
6. **Conversion angehen:** einziger dokumentierter Interessent (BERICHT, 21.10.) – Kontakt nachfassen, statt weiter Content-Volumen zu erhöhen.

---

## 9. Nicht geprüft / Einschränkungen

- **Buffer-Queue:** wegen `RATE_LIMIT_EXCEEDED` (24 h) nicht auslesbar.
- **launchd-Log und `~/.n8n`-Agentdateien:** liegen außerhalb des Projektordners und wurden nicht gelesen; Aussagen zur Pipeline stützen sich auf Dateizeitstempel und Deploy-Historie.
- **Stripe und D1:** nicht direkt abgefragt, nur über öffentliche Worker-Endpoints (`/api/stats`, `/api/health`, `/api/pixels`, `/api/recent`, `/api/referral`).
