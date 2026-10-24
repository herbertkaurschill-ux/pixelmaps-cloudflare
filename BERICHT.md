# Abschlussbericht PixelMaps – 21. Oktober 2026

## Zielsetzung
PixelMaps ohne Budget betreiben und Richtung 1 Mrd. verkaufter Pixel arbeiten. Fokus: alle offenen Defekte beheben, Buffer-Pipeline stabilisieren und Verkaufsfähigkeit verifizieren.

## Stand nach den Arbeiten
- **Verkauf:** 0 echte Verkäufe (14 Pixel sind Testkäufe). Einziger echter Interessent: `hgriggs725@gmail.com`. Funnel 30 Tage: 4 CTA → 32 Checkout-Open → 3 Submit → 0 Verkäufe.
- **Produktiv:** `https://pixelmaps.org` live, Worker `pixelmaps` (Deploy `68338cb1-64c6-4b3e-be29-129d05c41f42`), D1 `pixelmaps`, Assets, SEO-Seiten `/pixel-<slug>`, Leaderboard, Referral-Programm.
- **Ehrlichkeit:** `/api/stats` zeigt `sold:0`, Testnamen werden aus `/api/pixels` und `/api/recent` entfernt (anonym dargestellt).

## Durchgeführte Reparaturen

### 1) Clip-Erzeugung (daily)
- **Problem:** `clipmap.py` scheiterte seit ~05. Oktober unter `launchd` mit `PermissionError: Operation not permitted` beim Öffnen aus `~/Desktop`. Ursache: macOS TCC blockiert `/usr/bin/python3` (Command Line Tools) im Launchd-Kontext.
- **Lösung:** Umstellung auf `/opt/homebrew/bin/python3.11`, PATH/Definition korrigiert, Job-Skript aktualisiert. Unter launchd erfolgreich getestet (rc=0).
- **Ergebnis:** 4 neue Clips für 21. Oktober erzeugt (`TikTok`, `YouTubeShorts`, `Instagram`, `InstagramReel`), auf pixelmaps.org deployed.

### 2) Buffer-Queue & Tagesablauf
- **Problem:** Free-Plan limit 10 Posts/Kanal → Agent-Push schlug fehl („Scheduled posts limit reached"). Reihenfolge war falsch (Auffüllen vor Push).
- **Lösung:** `MAX` von 10 auf 7 gesenkt, `--trim` entfernt überschüssige späteste Posts, Reihenfolge umgestellt (trim → Agent-Push → Auffüllen), `publish-day.sh` synchron zwischen Projekt und `~/.n8n`.
- **Ergebnis:** **7/7/7 = 21** scheduled Posts, **3 Slots frei/Kanal** für frische Tagesbeiträge.

### 3) Buffer-Cleanup
- Pollinations-Bildpost (TikTok 23. Oktober) gelöscht und durch live Video ersetzt.
- `scripts/buffer-queue.cjs` zum korrekten Auslesen der paginierten Queue hinzugefügt.

### 4) SEO & Hygiene
- `public/robots.txt` angelegt (live 200), `<meta name="robots">` ergänzt, Testdaten gefiltert.

### 5) Referral-Programm
- Frontend + Backend vollständig implementiert (Modal/Box/Banner, Coupons, Gutschrift/Verbrauch). Lokaler E2E: **13/13 bestanden**. Prod `/api/referral` funktioniert, Schema heilt sich selbst.

## Verifikation

| Test | Ergebnis |
|---|---|
| Lokaler Referral-E2E | 13/13 pass |
| Prod Endpoint-Sweep (17 URLs) | Alle 200 (0,06–0,30 s) |
| Buffer-Queue | 21 scheduled, 7/7/7, alle Video-Assets |
| Clip-Push mit echtem Tagesclip | Funktioniert (Testpost gelöscht) |
| Agent-Generierung (Ollama qwen2.5:7b) | Posts für alle 3 Kanäle erzeugt |
| launchd-Kompatibilität (`docker exec`) | Getestet & ok |

## Aktueller Ablauf (automatisiert)
Täglich 09:10 via `com.pixelmaps.publish-day`:
1. Posts generieren (falls fehlend, via `docker exec` n8n/Agent)
2. Clips für TikTok/YouTubeShorts/Instagram rendern & deployen
3. Queue trimmen (auf 7/Kanal)
4. Agent pusht 3 frische Posts
5. Queue auffüllen (auf 7/Kanal, nur freie Tage)

## Bekannte Limits
- **Pollinations:** 0 Pollen → KI-Video aktuell deaktiviert (`ai.video=false`). Top-up nötig, danach reaktivierbar.
- **Buffer Free-Plan:** max. 10/Kanal (jetzt konservativ 7), Edits/Löschen alter Posts teils gesperrt.
- **Traffic:** Kein echter Verkauf trotz sauberer Pipeline. Fokus auf Traffic/Conversion nötig.

## Uncommitted Changes (Repo)
`public/index.html`, `src/worker.js`, `scripts/campaign/topup.mjs`, `scripts/fill-queue.cjs`, `scripts/publish-day.sh`, `scripts/campaign/.topup-state.json` (modifiziert). Neu: `migrations/0007_referrals.sql`, `public/robots.txt`, `scripts/buffer-queue.cjs`, `scripts/campaign/clip-index.cjs`, `scripts/campaign/repair-posts.mjs`, 4 Tagesclips 21.10.
