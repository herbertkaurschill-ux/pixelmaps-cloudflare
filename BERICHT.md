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

## YouTube-Erklärvideo (26.10.2026)
Erstes langes 16:9-Video (kein Kurzclip) über PixelMaps:

| Datei | Zweck |
| --- | --- |
| `public/videos/pixelmaps-erklaerung-de.mp4` | 49,1 s, 1920×1080, 30 fps, H.264/AAC, 8,5 MB |
| `public/videos/pixelmaps-erklaerung-de.srt` | Untertitel der Sprecher-Texte (9 Cues) |
| `public/videos/pixelmaps-erklaerung-de-thumb.jpg` | YouTube-Thumbnail 1280×720 |
| `scripts/youtube_explainer.py` | Renderer (9 Szenen, `say`-TTS, Musik, Kamerafahrt, Live-Stats) |

Öffentlich erreichbar unter `https://pixelmaps.org/videos/…` inkl. Range-Support (206).
Der Worker behandelt `/videos/` jetzt wie `/clips/` (`serveRange`), sonst wäre Seeking
im Browser nicht möglich gewesen.

Inhalt: Idee (1 Mrd. Kästchen) → ein Kästchen/eine Person → Auswahl des Punkts →
1 € einmalig → Urkunde → Länder-Rennen → freie Fläche → CTA. Alle Zahlen live aus
`/api/stats` (ehrlich: `sold: 0`), keine erfundenen Kennzahlen.

## Prüfprotokoll 01.–03.11.2026 (Abgleich „alles up to date“)

**Live-Seite**
- `https://pixelmaps.org/` → 200 in 0,48 s, Titel „PixelMaps — The Global Pixel Project“.
- Browser-Konsole: nur Tailwind-CDN-Warnung (kein Fehler); alle API-Aufrufe 200.
- Karte rendert (1000×636, 12 OSM-Kacheln) und ist nach Testdaten-Fix **ehrlich leer**: 0 Marker, „Nächster Meilenstein 0/100“, 0/30 Länder.
- `/api/stats` `sold:0`, `/api/pixels` `[]`, `/api/recent` `[]`, `/api/leaderboard` `total:0` (auch am 03.11. geprüft).
- Sitemap: 33 URLs, **0** `/p/`-Seiten. `/videos/*` (MP4/SRT/Thumb) alle 200.

**Tagesjob**
- launchd `com.pixelmaps.publish-day` Exit 0; Läufe am 02.11. und 03.11. fehlerfrei (je 3/3 Buffer-Pushs OK, Clips erzeugt).
- Deploys: 02.11. `b68746d5`, 03.11. `9d8485dc`; Clips 02./03.11. live (200).
- `publish-day.sh` (Host und `scripts/`) identisch; `orchestrator*.js` Host/Repo/Container synchron.

**Assets**
- 71 Campaign-Clips und alle Generated-Clips 25.10.–03.11. live (200).
- Fehlender `2026-10-25-Instagram.mp4` aus `InstagramReel.mp4` ergänzt (war 404).
- Alle in Buffer geplanten Asset-URLs live.

**Behobene Fehler**
1. Test-Pixel erschienen in `/api/pixels`, `/api/recent` und Sitemap → jetzt ausgeschlossen (deployt als `2cd8826d`).
2. `fill-queue.cjs`/`topup.mjs` lasen nur die ersten 10 Buffer-Posts → belegte Tage galten als frei. Jetzt fensterweise Abfrage (max. 4 Tage); Trockenlauf: 0 neue Doppel-Posts.
3. `orchestrator-push.js` zählte `undefined` (falsches Feld) → korrigiert (`chan`, `haveDays.size`).
4. **Eigentliche Duplikat-Ursache:** `agent.js` pushte mit `mode: addToQueue`; Buffer wählte den Slot selbst und legte ihn auf bereits fest geplante Campaign-Tage. Beim Löschen verschoben sich diese Posts erneut (beobachtet), deshalb mehrere Durchgänge nötig. Jetzt sucht `agent.js` über die fensterweise Queue einen freien Tag und plant fest (`customScheduled`, 16:00/16:15/16:30 UTC). Host + Container synchron.
5. **Trim-Schutz für den Tages-Push:** `fill-queue.cjs` unterstützt `--reserve 1`; der 09:10-Job trimmt vorher auf 6 Posts/Kanal, damit der eine frische Agent-Post pro Kanal nicht am Queue-Ende landet und anschließend als „am weitesten entfernt“ gelöscht wird. Der Lauf am 04.11. bestätigt: 0 Fehler, 0 Duplikate.
6. Test-Diagnosepost in Buffer gelöscht.

**Duplikat-Bereinigung (freigegeben)**
- 9 überzählige Posts in zwei Durchgängen gelöscht (je Tag blieb ein Post); alle Löschungen `DeletePostSuccess`.
- Ursache der zweiten Welle: `addToQueue`-Posts verschoben sich beim Löschen nach vorn und trafen erneut Campaign-Tage.
- Anschließend 9 curated Posts via `topup.mjs` neu geplant.
- **Endstand verifiziert:** TikTok 7, Instagram 7, YouTubeShorts 7 scheduled, **0 Duplikate**, alle `customScheduled`.
- `nextFreeDay` live getestet (TikTok → 11.11.); Queue bleibt damit stabil.

**Nachtrag 04.11.2026**
- 09:10-Lauf: **0 Fehler**, 3/3 Buffer-Pushs, Clips 04.11. erzeugt und live.
- Queue danach: TikTok 6, Instagram 6, YouTubeShorts 6 scheduled, **0 Duplikate**; je ein Post/Kanal wurde heute bereits veröffentlicht.
- Trim-Schutz lief (7 Trims mit Reserve 3). Ab 05.11. gilt Reserve 1, damit nur der eine frische Agent-Post pro Kanal geschützt wird.

**Offen**
- Pollinations 0 Pollen (`ai.video=false`), GSC-Sitemap wartet auf Google-Login.

## Änderungen in diesem Arbeitsstand (03.11.2026)
`public/index.html`, `src/worker.js`, `scripts/campaign/topup.mjs`, `scripts/fill-queue.cjs`, `scripts/publish-day.sh`, `scripts/campaign/.topup-state.json` (modifiziert). Neu: `migrations/0007_referrals.sql`, `public/robots.txt`, `scripts/buffer-queue.cjs`, `scripts/campaign/clip-index.cjs`, `scripts/campaign/repair-posts.mjs`, 4 Tagesclips 21.10. Außerhalb des Repos zusätzlich geändert: `~/.n8n/agent/agent.js` (Freie-Tage-Planung) inkl. Container-Kopie sowie `~/.n8n/publish-day.sh` (identisch zu `scripts/publish-day.sh`).
