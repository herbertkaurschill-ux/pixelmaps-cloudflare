# Agenten-Runde: besseren Content machen

Stand: 2026-10-03. Gefragt wurden die lokalen Agenten `qwen2.5:7b` und
`llama3.2:3b` ueber `scripts/campaign/agent-consult.py`.

## Was die Agenten gesagt haben

Runde 1 (offene Frage nach neuen Formaten):

- qwen2.5:7b: Pixel-Explosion, Pixel im Kontext (T-Shirt), Pixel fliegen aus
  der Kamera auf die Karte. Form B brauche mehr Emotion.
- llama3.2:3b: Pixel-Quiz, Pixel-Saga, Pixel-Hintergrund. Formate seien zu
  kurz, zu konventionell, ohne emotionale Verbindung.
- **Uebereinstimmung der Kernaussagen: 25%**

Runde 2 (mit der Korrektur, dass wir keine Reichweitendaten haben):

- Beide nennen als Hauptproblem **Ladezeit** und schlagen vor, Karten-Animation
  bzw. Kaffee-Element zu entfernen, um "Ladezeit zu reduzieren".
- llama3.2:3b will die Clips auf 10-15 Sekunden verlaengern, damit mehr
  "Geschichte" Platz hat.
- **Uebereinstimmung der Kernaussagen: 15%**

## Was davon haltbar ist: nichts davon

Beide Runden widersprechen sich untereinander (25% bzw. 15% Uebereinstimmung),
und die wenigen Punkte, die sich wiederholen, sind messbar falsch:

| Behauptung der Agenten | Messung | Ergebnis |
|---|---|---|
| "Ladezeit ist zu hoch" | 546-713 kbps, 482-648 KB | Laedt in unter einer Sekunde. TikTok akzeptiert bis 500 MB. |
| "Clips sind mit 5-7s zu kurz" | 5.5s und 6.0s | Das ist der Bereich, in dem Replay-Raten hoch sind. Laenger heisst hier eher weniger Retain. |
| Alte Videos waren langsamer | v05: 225 kbps | Unsere neuen Clips sind die *schnelleren*. |

Die Formate sind laut `clipstats` die mit den meisten Website-Requests
(c5-dialog 19, c1-proof 14 am 03.10.) - aber das ist keine Performance-Aussage.

## Der eigentliche Befund: wir haben keine Daten

`/api/clipstats`zaehlt HTTP-Requests auf die **eigene Website**. Die 83
Clip-Requests am 03.10. sind zu 42 unseren eigenen Test-Downloads
(die `concepts/`-Clips existierten erst an diesem Tag). Es gibt null Daten zu:

- Impressionen, Plays, 3-Sekunden-Retention, Rewatch-Rate
- Abos, Profilbesuche, Klicks auf pixelmaps.org
- ob TikTok und Instagram unsere Clips ueberhaupt ausspielen

Meine Einschaetzung: Die groesste Unsicherheit ist nicht das Format, sondern
dass wir seit Wochen Formate optimieren, ohne eine einzige echte
Reichweitenmessung. Vielleicht spielt TikTok die Clips gar nicht aus - dann
ist jedes Creative egal.

## Was ich als Naechstes vorschlage

1. **Eine echte Messung bauen, bevor weiter Formate gebaut werden.**
   Ueber die Plattform-APIs (TikTok/IG Insights) Impressionen und
   durchschnittliche Watchtime holen. Ohne das ist alles Weitere Raten.
2. **Ein billiger Test statt einer Serie:** dieselben zwei Clips in je drei
   Varianten (anderer erster Frame, andere Laenge) und drei Tage laufen lassen.
   Bei 12Posts/Tag auf drei Kanaelen ist das machbar.
3. **Den Text im ersten Frame pruefen.** Aktuell starten c1 und c5 mit
   "DEIN ORT." bzw. "Dein Pixel". Ein konkreterer Einstieg
   ("Dein Haus. Fuer 1 EUR.") ist die naheliegendste billige Aenderung.
4. **Keine 10-15-Sekunden-Videos.** Die Agenten empfehlen das, aber es
   widerspricht der Retry-Logik kurzer Clips.
## Nachtrag: echte Reichweitendaten (2026-10-03)

Buffer liefert ueber `aggregatedPostMetrics` echte Plattformzahlen. Bisher
wussten wir das nicht - `/api/clipstats` ist nur ein Website-Zaehler.
Skript: `scripts/campaign/insights.mjs`.

Gesamt, letzte 30 Tage:

| Metrik | Wert |
|---|---|
| Posts | 43 |
| Views | 2159 |
| Reaktionen | 7 |
| Kommentare | 0 |
| Views pro Post | 50.2 |
| Reaktionen pro 1000 Views | 3.2 |

**Das eigentliche Problem, aufgeschluesselt nach Kanal:**

| Kanal | Views |
|---|---|
| YouTube | 1461 (100%) |
| TikTok | 0 |
| Instagram | 0 |

Und innerhalb YouTube: ein einziger Post ("What if 1 billion people each
buy a pixel") hat **949 Views = 65% aller Views**. Ohne ihn sind es 42.7
Views pro Post ueber die restlichen 12 Posts.

Nur 27% der veroeffentlichten Posts haben ueberhaupt Views > 0.

### Daraus folgende Entscheidungen

1. **TikTok und Instagram liefern 0 Views.** Das ist kein Creative-Problem,
   sondern entweder Reichweite, Schattenban oder ein Zustellungsproblem.
   Die drei "modernen" Clips dort zu testen ist derzeit wertlos.
2. **Der erfolgreichste Post ist eine Frage im ersten Frame** ("What if...").
   Darauf basieren die A/B-Varianten des ersten Frames:
   - `q`   -> "1 BILLION QUESTIONS?" (die Frage)
   - `own` -> "YOUR HOUSE. EUR1." (der Besitz)
3. **0 Kommentare bei 2159 Views** heisst: es wird nicht diskutiert, nur
   passiv gesehen. Das spricht fuer einen konkreten Anlass zum Schreiben
   (Umfrage, Aufgabe, Streitfrage) statt fuer Produktwerbung.

**Erster Frame, Variante `own` (empfohlen):** https://pixelmaps.org/clips/campaign/c1-proof-en-own.mp4
**Erster Frame, Variante `q`:** https://pixelmaps.org/clips/campaign/c1-proof-en-q.mp4
