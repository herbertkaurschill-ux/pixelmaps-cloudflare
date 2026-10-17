#!/usr/bin/env python3
"""Fragt die lokalen Agenten (Ollama) un unabhaengig um Content-Ideen.

Zwei Modelle, zwei Blickwinkel, danach per Keyword-Aehnlichkeit dedupliziert
und gewichtet. Zweck: nicht einen einzelnen Vorschlag uebernehmen, sondern
sehen, worin die Modelle uebereinstimmen - das ist die belastbarere Info.

Nutzung:
  python3 agent-consult.py                 # beide Modelle
  python3 agent-consult.py --model llama3.2:3b
  PROMPT="eigene Frage" python3 agent-consult.py
"""
import argparse
import json
import os
import re
import urllib.error
import urllib.request
from collections import defaultdict
from urllib.parse import urljoin

URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")

SYSTEM = (
    "Du bist ein Social-Media-Stratege fuer PixelMaps. PixelMaps verkauft auf "
    "einer Weltkarte (40.000 x 25.000 Kacheln) einzelne Pixel fuer 1 EUR. "
    "Zielgruppen: Deutschland, Europa, Indien, USA. Die Clips sind 1080x1920 "
    "vertikal, 5-7 Sekunden, auf Deutsch und 6 weiteren Sprachen. "
    "Bisherige Formate: (1) Beweis - Karte fliegt ran, Pixel fuellt sich, "
    "Zertifikat erscheint. (2) Zwei Pixel - Split-Screen, dein Pixel fuer "
    "immer gegen ein Kaffee, das in 20 Minuten weg ist. "
    "Antworte auf Deutsch, konkret, ohne Füllwörter, keine Zahlen erfinden."
)

# Wir haben KEINE echten Reichweitendaten. Das ist der wichtigste Punkt:
# die Agenten wuerden sonstoptimieren, ohne zu wissen, wo es klemmt.
KEINE_DATEN = """WICHTIG - unsere Datenlage:
Wir haben KEINE echten Reichweitendaten. Was wir haben, zaehlt HTTP-Requests
auf unsere eigene Website, und die sind zu ueber 50% unsere eigenen Test-
Downloads. Es gibt null Daten zu Impressionen, Plays, Retention, Rewatch
oder Abo-Neuzugaengen. Niemand weiss, ob unsere Clips auf TikTok oder
Instagram ueberhaupt ausgespielt werden.

Deshalb ist die Frage nicht 'welches Format hat die beste Performance',
sondern: was ist das groesste Risiko, dass TikTok unsere Clips gar nicht
erst ausspielt, und was koennen wir mit SICHERER Hand aendern?"""


def ask(model, prompt, timeout=180):
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": prompt},
        ],
        "options": {"temperature": 0.85, "num_predict": 900},
        "stream": False,
    }).encode()
    req = urllib.request.Request(
        urljoin(URL, "/api/chat"), data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode()).get("message", {}).get("content", "")


def tags():
    with urllib.request.urlopen(urljoin(URL, "/api/tags"), timeout=10) as r:
        return [m["name"] for m in json.loads(r.read().decode()).get("models", [])]


# ── Gemini als dritte Meinung ──────────────────────────────────────────
# Zwei lokale 7B/3B-Modelle lieferten nur 15-25% Uebereinstimmung und beide
# wiederholten Punkte, die messbar falsch waren. Gemini ist deutlich staerker
# und dient deshalb als Referenz gegen die lokalen Modelle.
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models"
# maxOutputTokens muss gross sein: die Modelle denken erst (thoughtsTokenCount)
# und antworten danach. Bei kleinen Werten bleibt die Antwort leer.
GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash"]


def gemini_key():
    p = os.environ.get("GEMINI_API_KEY")
    if p:
        return p
    try:
        with open("/Users/up/Desktop/jarvis-mark53/config/api_keys.json") as f:
            return json.load(f).get("gemini_api_key", "")
    except Exception:
        return ""


def ask_gemini(model, prompt, attempt=0):
    key = gemini_key()
    if not key:
        raise RuntimeError("kein Gemini-Key")
    body = json.dumps({
        "contents": [{"parts": [{"text": SYSTEM + "\n\n" + prompt}]}],
        "generationConfig": {"maxOutputTokens": 4000, "temperature": 0.85},
    }).encode()
    req = urllib.request.Request(
        f"{GEMINI_URL}/{model}:generateContent?key={key}",
        data=body, headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            j = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = json.loads(e.read().decode()).get("error", {}).get("message", "")
        if attempt < 2 and ("demand" in detail.lower() or e.code == 503):
            import time
            time.sleep(6 * (attempt + 1))
            return ask_gemini(model, prompt, attempt + 1)
        raise RuntimeError(f"HTTP {e.code}: {detail[:120]}")
    if "error" in j:
        raise RuntimeError(j["error"].get("message", "?")[:120])
    parts = j["candidates"][0]["content"].get("parts", [])
    txt = "".join(p.get("text", "") for p in parts).strip()
    if not txt:
        raise RuntimeError("leere Antwort")
    return txt


STOP = set("""die der das den dem des ein eine einen einem eines und oder aber
fuer mit auf ist sind war sein hat haben wird werden kann koennen nicht nur
noch schon wenn dann aber auch sehr mehr wie so bei aus fuer fuer ohne
man sollte wuerde wuerden macht machen gehaendert aehnlich gute guten""".split())


def keywords(text, n=40):
    words = re.findall(r"[A-Za-zÄÖÜäöüßÀ-ÿ]{4,}", text.lower())
    freq = defaultdict(int)
    for w in words:
        if w in STOP:
            continue
        freq[w] += 1
    return {w for w, _ in sorted(freq.items(), key=lambda x: -x[1])[:n]}


def overlap(a, b):
    ka, kb = keywords(a), keywords(b)
    return len(ka & kb) / max(1, min(len(ka), len(kb)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="")
    ap.add_argument("--prompt", default="")
    ap.add_argument("--no-gemini", action="store_true",
                    help="nur die lokalen Modelle fragen")
    a = ap.parse_args()

    prompt = a.prompt or (
        KEINE_DATEN + "\n"
        "Unsere beiden besten Formate sind:\n"
        "(A) Der Beweis: Karte fliegt ran, Pixel fuellt sich, Zertifikat kommt.\n"
        "(B) Zwei Pixel: dein Pixel vs. ein Kaffee, der in 20 Minuten weg ist.\n\n"
        "Beide sind 5-7 Sekunden vertikal. Wir haben fast keine Reichweite.\n\n"
        "1. Welche drei neuen Formate (nicht A und B) sind am vielversprechendsten?\n"
        "2. Was ist jeweils der konkrete erste Frame, der den Scroll stoppt?\n"
        "3. Welche Fehler machen unsere Formate aktuell?\n"
        "4. Welche eine Aenderung an A oder B wuerde den groessten Unterschied machen?"
    )

    models = [a.model] if a.model else tags()
    if not a.model and not a.no_gemini and gemini_key():
        models.append(GEMINI_MODELS[0])
    print(f"Modelle: {', '.join(models)}\n" + "=" * 70)
    answers = {}
    for m in models:
        print(f"\n>>> {m}\n")
        try:
            txt = ask_gemini(m, prompt) if m.startswith("gemini") else ask(m, prompt)
        except Exception as e:
            print(f"FEHLER {m}: {e}")
            continue
        answers[m] = txt
        print(txt)

    if len(answers) > 1:
        print("\n" + "=" * 70)
        ms = list(answers)
        # Alle Paare vergleichen, nicht nur die ersten beiden: sonst faellt
        # Gemini aus der Auswertung heraus, obwohl es mitgeraten hat.
        for i in range(len(ms)):
            for j in range(i + 1, len(ms)):
                a, b = ms[i], ms[j]
                pct = overlap(answers[a], answers[b])
                print(f"Uebereinstimmung {a} <-> {b}: {pct:.0%} der Kernaussagen")
        # Was sagen alle gemeinsam? Das ist die belastbare Kernidee.
        common = set.intersection(*(keywords(t) for t in answers.values()))
        print(f"\nAllen {len(ms)} Modellen gemeinsam: ", ", ".join(sorted(common)))
        # Und worin sind sie sich uneinig - das sind die offenen Entscheidungen.
        for a in ms:
            nur_a = keywords(answers[a]) - set.union(*(
                keywords(answers[b]) for b in ms if b != a))
            if nur_a:
                print(f"  nur {a}: {', '.join(sorted(nur_a))[:200]}")


if __name__ == "__main__":
    main()