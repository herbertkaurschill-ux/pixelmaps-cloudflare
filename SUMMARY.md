# PixelMaps – Summary (Update: 25.09.2026)

## Objective
Pixelmaps.org in den Verkauf bringen + organisch wachsen lassen.
- Bezahlen-Flow robust (Webhook + Verify-on-Return) – **erledigt & live verifiziert**.
- Content-Pipeline: täglich 1 Clip/Kanal via n8n, zusätzlich Kampagnen-Videobibliothek.
- **Letzter Schritt (fertig):** Buffer-Zeitplan durch die 38er Kampagnenbibliothek **ersetzt** –
  27 Posts (9/Kanal) für 26.09.–04.10., 15–18:00Z, `https://pixelmaps.org/clips/campaign/*.mp4` (live, HTTP 200).

## Important Details
- **Stripe Webhook**: Endpoint „PixelMaps" `https://pixelmaps.org/api/stripe-webhook`, ID `we_1UHVYP5xBV1KRd3QKWCKDuOa`, 3 Events, API `2026-08-26.dahlia`. Secret `whsec_ycctwFDR61xv0T21tv9ZveifXXSfWxF8` in wrangler env. Signatur-Test: gültig → 200, ungültig → 400. **Achtung:** Sessions/Schlüssel sind LIVE (`cs_live_*`, sk_live); Stripe-CLI nur Sandbox (`acct_1UG3CO6S0BQGwlbi`).
- **Zahlungs-Flow**: Worker-Helper `completePaidSession(env, s)` (idempotent: Mark paid, Pixel-Insert mit Conflict+Refund, Zertifikat, PDF, Mail nur wenn `!wasPaid`). Return-Seite ruft `/api/checkout/verify?session_id=` (bis 10×1,5s Retry). Echter Live-Kauf `d03d40bd…` (Pixel 320572801) → paid, Zert. `PM-0320572801-59137AEB`, Resend-Mail ok.
- **Buffer**: Account ist **Free-Plan → max. 10 scheduled/Kanal**. 22.09. scheiterte mit „Scheduled posts limit reached (10/10)" → erklärte die „nur 3 Instagram-Posts". GraphQL (`api.buffer.com`, Bearer-Token aus `/Users/up/.n8n/agent/config.json`):
  - `posts(first:100,input:{organizationId})` (max. 100!),
  - `deletePost(input:{id})` → Fragment `... on DeletePostSuccess { id }` (kein `post`-Feld!),
  - `createPost(input)` → `assets: [{ video: { url, metadata: { title } } }]` (AssetInput braucht `video:`-Wrapper!), `metadata` je Plattform (`youtube`/`instagram`), `mode:"customScheduled"`, `dueAt`, `needsApproval:false`.
  - Rate-Limit `RATE_LIMIT_EXCEEDED` (window 15m) bei Bursts → Skript pauziert mit Backoff.
- Kanäle: TikTok `6ab15281ea19ca0bdea6de7d`, Instagram `6aafe9f8ea19ca0bde96e0db`, YouTubeShorts `6ab14817ea19ca0bdea67a6e`; Org `6aafe8c03cf501260e7e406c`.
- Launchd/TCC: Clips ab 22.09. nicht generiert („Operation not permitted", Skripte auf Desktop). Vorab-Batch reicht bis ~05.10.

## Work State
### Completed
- Bezahl-Flow + Webhook live, Live-Testkauf finalisiert.
- **Neue Automatisierungs-Agenten eingerichtet** (Ordner `/Users/up/.n8n/agent/`, Start via `~/n8n/run-agents.sh`, Ollama qwen2.5:7b, Reports nach `~/n8n/content/agents/<datum>/` + `review/agents.log`):
  - `common.js` (Helfer), `moderation.js`, `health.js`, `funnel.js`, `campaign-check.js`.
  - Worker-Endpoints neu: `/api/moderation/queue` + `/api/moderation/review` (Admin-Key-Mutation, Schreibschutz via `MODERATION_KEY`-Secret; Key zusätzlich in `agent/config.json`), `/api/health` (aggregiert, ohne personenbezogene Daten), dazu Worker-Boot-Schema-Migration.
  - Läuft: Moderator prüft Pixel-Inhalte (AGB §7) per Ollama und setzt Status in D1; Health meldet kritische Werte (z.B. 4 verwaiste Checkout-Sessions); Funnel vergleicht A/B-Events (`/api/events`, 7 Tage); Campaign-Check bewertet die Kampagnen-Videotexte (1 Warnung: v04-world-record – „Weltrekord als gesicherte Tatsache", bitte als Ziel formulieren).
- `clipmap.py` erweitert (`--claim <json>`, `--focus lat,lon,zoom`, `--scenes <json>`; parameterisierte `build_story`). `scripts/campaign/videos.json` = 38 Videos (31 DE + 7 EN), `render.js` (ESM, P=5) → 38 MP4 → `public/clips/campaign/` (lokal + deployt, jetzt HTTP 200).
- `scripts/campaign/push-buffer.mjs`: `status` / `replace`. **29.09-Ausführung erfolgreich:** 30 alte scheduled Posts gelöscht (30/30), 27 neue geplant (9 pro Kanal, 3 Slots/Tag 15–18:00Z, 26.09.–04.10.), State in `.buffer-state.json`. Teilausfall am 25.09. (Fragment/Asset/429) ist Geschichte – Skript ist idempotent-mit-Backoff.

### Active
- Nichts. Buffer läuft bis 04.10. (danach Top-Up: `node scripts/campaign/push-buffer.mjs replace` neu ausführen – löscht und replant aus Bibliothek).

### Blocked
- YouTube/TikTok-Veröffentlichung trotz `sent`: Buffer-Verknüpfung im Dashboard (User-Aktion, wie zuvor dokumentiert).
- Ab ~05.10.: Daily-Clip-Generierung via launchd steht (TCC) – Skripte von Desktop verlagern, wenn Daily-Betrieb gewünscht.

## Next Move (sobald beauftragt)
1. Nach 04.10. erneut `replace` ausführen (oder automatisieren). Vorher prüfen, ob `fill-queue` zeitgleich laufen soll – täglicher 10er-Slot-Verbrauch konkurriert mit Kampagne.
2. YouTube/TikTok-Reconnect im Buffer-Dashboard.
3. Optional: `marketing.stripeSecretKey`/`youtubeApiKey` in config hinterlegen.

## Relevant Files
- `/Users/up/Desktop/pixelmaps-cloudflare/` – Worker (`src/worker.js`: checkout, verify, webhook, serveRange, A/B), Frontend `public/index.html`, Video-Batch `scripts/clipmap.py`, Kampagne `scripts/campaign/{videos.json,render.js,push-buffer.mjs,.buffer-state.json}`, Clips `public/clips/{generated,campaign}/`.
- `/Users/up/.n8n/` – Agent-config, `fill-queue.js`, `publish-day.sh`, Logs `content/review/publish-day.log`, Buffer-Queue-Topup.