#!/usr/bin/env python3
"""Design-Prototypen fuer die PixelMaps-Kampagne.

Die bestehenden Videos (scripts/clipmap.py, kind="claim") sind statische
Karten mit einem Textblock: eine Praesentationsfolie im Hochformat. Dieser
Renderer baut bewusst andere Formate — echte Ereignisse, harte Schnitte,
Zaehler, Preisanker — damit wir sie als Beispiel ansehen koennen.

Nutzung:
    python3 scripts/campaign/concepts.py            # alle 5 rendern
    python3 scripts/campaign/concepts.py --only 1,3 # Auswahl

Ausgabe: public/clips/concepts/c<N>-<slug>.mp4
"""
import argparse
import json
import math
import os
import random
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(os.path.dirname(HERE))
ASSETS = os.path.join(HERE, "..", "assets")
OUT = os.path.join(BASE, "public", "clips", "concepts")

W, H, FPS = 1080, 1920, 30
SR = 44100

# ── Farbwelt (identisch zum Markengrau/Gruen der Website) ────────────────
BG = (5, 9, 17)
GREEN = (110, 231, 183)
CYAN = (86, 225, 236)
WHITE = (255, 255, 255)
SOFT = (166, 240, 255)
DIM = (120, 150, 175)
AMBER = (251, 191, 36)

# Avenir Next liegt in /System/Library/Fonts/, NICHT in Supplemental/. Der alte
# Pfad hat dazu gefuehrt, dass font() auf PILs 10px-Bitmap-Fallback zurueckfiel
# und im Clip gar kein lesbarer Text stand.
AVENIR_PATHS = [
    "/System/Library/Fonts/Avenir Next.ttc",
    "/System/Library/Fonts/Supplemental/Avenir Next.ttc",
]
FALLBACKS = [
    ("/System/Library/Fonts/HelveticaNeue.ttc", {"bold": 1, "demi": 5, "medium": 5, "regular": 0}),
    ("/System/Library/Fonts/Helvetica.ttc", {}),
    ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", {}),
    ("/System/Library/Fonts/Supplemental/Verdana.ttf", {}),
]
# Face-Indizes in Avenir Next.ttc (verifiziert per getname())
AVENIR_IDX = {"bold": 0, "demi": 2, "medium": 5, "regular": 7, "black": 8}

# Sprachabhaengige Schriftfamilien. Avenir Next deckt Latein UND Kyrillisch
# (getestet: ДЯЖюзБВГ -> 8/8), aber weder Devanagari (Hindi) noch CJK
# (Chinesisch). Ohne eigene Systemschrift rendert dort ein Ersatzkasten (Tofu),
# der im Clip wie ein Fehler wirkt. Verifiziert per fontTools-cmap:
#   Devanagari Sangam MN.ttc -> hi 9/9   Hiragino Sans GB.ttc -> zh 9/9
HI_PATHS = ["/System/Library/Fonts/Supplemental/Devanagari Sangam MN.ttc",
            "/System/Library/Fonts/Supplemental/ITFDevanagari.ttc",
            "/System/Library/Fonts/Supplemental/DevanagariMT.ttc"]
HI_IDX = {"bold": 1, "demi": 1, "medium": 1, "regular": 0, "black": 1}
ZH_PATHS = ["/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/System/Library/Fonts/Supplemental/Songti.ttc",
            "/System/Library/Fonts/STHeiti Medium.ttc"]
ZH_IDX = {"bold": 2, "demi": 2, "medium": 0, "regular": 0, "black": 2}
FAMILIES = {
    "latin": (AVENIR_PATHS, AVENIR_IDX),
    "hi": (HI_PATHS, HI_IDX),
    "zh": (ZH_PATHS, ZH_IDX),
}
_CUR_FAMILY = "latin"

_font_cache = {}


def set_font_lang(lang):
    """Waehlt die Schriftfamilie fuer die aktuelle Sprache (render() ruft das)."""
    global _CUR_FAMILY
    _CUR_FAMILY = "hi" if lang == "hi" else "zh" if str(lang).startswith("zh") else "latin"


def set_font_family(fam):
    global _CUR_FAMILY
    _CUR_FAMILY = fam if fam in FAMILIES else "latin"


def cur_font_family():
    return _CUR_FAMILY


def draw_latin(d, text, cx, y, pt, style, fill):
    """Brand-/Preistext immer in der lateinischen Familie zeichnen: das
    Devanagari-Font hat kein '€' und kein '·', sonst steht dort ein Tofu-
    Kasten mitten im Preis."""
    prev = cur_font_family()
    set_font_family("latin")
    f = font(pt, style)
    d.text((cx - d.textlength(text, font=f) / 2, y), text, font=f, fill=fill)
    set_font_family(prev)


def font(size, style="regular"):
    from PIL import ImageFont
    fam = _CUR_FAMILY
    key = (fam, size, style)
    if key in _font_cache:
        return _font_cache[key]
    search = [FAMILIES.get(fam, FAMILIES["latin"])]
    if fam != "latin":                      # Notnagel: lateinische Familie zuerst pruefen
        search.append(FAMILIES["latin"])
    for paths, idx in search:
        for p in paths:
            if os.path.exists(p):
                try:
                    f = ImageFont.truetype(p, size, index=idx.get(style, idx.get("regular", 0)))
                except Exception:
                    continue
                _font_cache[key] = f
                return f
    for p, idxmap in FALLBACKS:
        if os.path.exists(p):
            try:
                f = ImageFont.truetype(p, size, index=idxmap.get(style, 0))
            except Exception:
                f = ImageFont.truetype(p, size)
            _font_cache[key] = f
            return f
    raise RuntimeError("Keine verwendbare Systemschrift gefunden - Text waere unlesbar")


def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))


def ease_out(t):
    return 1 - (1 - t) ** 3


def ease_in_out(t):
    return 3 * t * t - 2 * t * t * t


def draw_tracked(d, text, f, cx, y, fill, tracking=6):
    """Text mit Sperrung — ojoegt für Eyebrow-Zeilen."""
    total = 0
    for ch in text:
        total += d.textlength(ch, font=f) + tracking
    total -= tracking
    x = cx - total / 2
    for ch in text:
        d.text((x, y), ch, font=f, fill=fill)
        x += d.textlength(ch, font=f) + tracking


# ── Layout-Regeln ───────────────────────────────────────────────────────
# Plattform-UI ueberlagert den oberen und unteren Rand: bei TikTok/Instagram
# liegen Profil, Caption und Aktions-Buttons ueber dem Video. Text dort ist
# weggeclippt. Deshalb ein hartes Raster statt frei gesetzter Y-Werte.
SAFE_TOP = 320      # darunter: eigene Kopfzeile erlaubt
SAFE_BOTTOM = 1600  # darueber: nichts Eigenes
ROW_GAP = 26        # Abstand zwischen zwei Textzeilen


def row_h(pt):
    return int(pt * 1.28)


def stack_rows(sizes, base=1500, gap=ROW_GAP):
    """Zeilen stapeln; Eingabereihenfolge = visuelle Reihenfolge von OBEN.

    Gibt [(y, hoehe), ...] in derselben Reihenfolge wie `sizes` zurueck.
    Wichtig: kumuliert die Hoehen aller darunterliegenden Zeilen. Eine
    Formel wie base-(i+1)*h-i*gap benutzt nur die eigene Hoehe und laesst
    Zeilen unterschiedlicher Groesse ineinanderlaufen.
    """
    total = sum(row_h(pt) for pt in sizes) + gap * (len(sizes) - 1)
    y = base - total
    out = []
    for pt in sizes:                      # von oben nach unten
        h = row_h(pt)
        out.append((y, h))
        y += h + gap
    return out


def in_safe_zone(y, h, name):
    if y < SAFE_TOP:
        raise AssertionError(f"{name}: y={y} liegt im Plattform-UI (min {SAFE_TOP})")
    if y + h > SAFE_BOTTOM:
        raise AssertionError(f"{name}: y+h={y + h} ragt ins Plattform-UI (max {SAFE_BOTTOM})")


def check_layout(name, boxes):
    """boxes: Liste von (y, hoehe, label). Prueft Ueberlappung und Safe-Zone.

    Achtung: das zweite Element ist die HOEHE, nicht die Unterkante — sonst
    vergleicht man Hoehen mit Positionen und der Guard greift nie.
    """
    rects = []
    for y, h, label in boxes:
        in_safe_zone(y, h, f"{name}/{label}")
        rects.append((y, y + h, label))
    for i in range(len(rects)):
        for j in range(i + 1, len(rects)):
            a1, b1, l1 = rects[i]
            a2, b2, l2 = rects[j]
            if a1 < b2 and a2 < b1:
                raise AssertionError(
                    f"{name}: '{l1}' ({a1}..{b1}) und '{l2}' ({a2}..{b2}) "
                    f"ueberlappen um {min(b1, b2) - max(a1, a2)}px")
    return True


def load_map():
    p = os.path.join(ASSETS, "world_navy.png")
    return Image.open(p).convert("RGB")


def base_canvas(world):
    """Hochformat-Background fuer Konzepte ohne Kartenausschnitt.

    Die Weltkarte ist quadratisch (1600x1600). Bei 9:16 wuerde ein
    Cover-Crop ~44% der Laengengrade abschneiden, also legen wir die
    Karte in die obere Haelfte und fuellen den Rest mit dem
    Hintergrund — der Verlauf von scrim() ueberblendet die Kante.
    """
    im = Image.new("RGBA", (W, H), BG + (255,))
    mw = world.resize((W, W), Image.LANCZOS).convert("RGBA")
    im.paste(mw, (0, 0), mw)
    return im


def latlon_to_px(lat, lon, crop_box):
    """Koordinaten in Bildschirmkoordinaten umrechnen (Ausgabe immer W/H)."""
    x0, y0, x1, y1 = crop_box
    sx, sy = (W * 2) / (x1 - x0), (W * 2) / (y1 - y0)
    cx = (lon + 180.0) / 360.0 * (W * 2)
    cy = (90.0 - lat) / 180.0 * (W * 2)
    return ((cx - x0) * sx, (cy - y0) * sy)


def sale_pixels():
    path = os.path.join(ASSETS, "sold_pixels.json")
    try:
        return json.load(open(path))
    except Exception:
        return []


def sold_points(lat, lon, d):
    """Verkaufte Pixel als leuchtende Punkte auf der Karte."""
    for p in sale_pixels():
        px = p.get("lat", 0)
        py = p.get("lon", 0)
        if abs(px - lat) < 60 and abs(py - lon) < 60:
            x, y = latlon_to_px(px, py, d)
            if -50 < x < W + 50 and -50 < y < H + 50:
                yield x, y


def grain(im, strength=7, seed=0):
    """Feines Filmkorn — nimmt der Fläche das sterile GIF-Gefuehl."""
    if strength <= 0:
        return im
    rnd = np.random.default_rng(seed)
    a = np.asarray(im).astype(np.int16)
    n = rnd.normal(0, strength, a.shape[:2])[..., None]
    a = np.clip(a + n, 0, 255).astype(np.uint8)
    return Image.fromarray(a)


def glow_layer(size, cx, cy, r, color, alpha=160):
    ov = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (alpha,))
    return ov.filter(ImageFilter.GaussianBlur(r // 2))


def scrim(im, top=0, bottom=1250, strength=245):
    """Textkontrast: dunkler Verlauf von unten."""
    ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for i in range(bottom, im.size[1]):
        a = int(strength * (1 - (im.size[1] - i) / (im.size[1] - bottom)) ** 1.6)
        d.rectangle([0, i, im.size[0], i], fill=BG + (a,))
    if top:
        for i in range(top):
            a = int(strength * (1 - i / top))
            d.rectangle([0, i, im.size[0], i], fill=BG + (a,))
    return Image.alpha_composite(im.convert("RGBA"), ov)


def badge(im, text="PIXELMAPS.ORG"):
    d = ImageDraw.Draw(im)
    f = font(34, "medium")
    tw = d.textlength(text, font=f) + 52
    d.rounded_rectangle([34, 34, 34 + tw, 104], radius=34,
                        fill=(8, 20, 38, 210), outline=CYAN + (210,), width=2)
    d.text((60, 48), text, font=f, fill=CYAN)
    return im


def progress_dots(d, n, idx, y, color=GREEN):
    """Fortschrittspunkte — signalisiert 'es gibt noch mehr'."""
    gap, r = 34, 6
    total = (n - 1) * gap
    x0 = W / 2 - total / 2
    for i in range(n):
        c = color if i <= idx else (70, 95, 120)
        d.ellipse([x0 + i * gap - r, y - r, x0 + i * gap + r, y + r], fill=c)


def progress_bar(d, p, y=1810, color=GREEN):
    w, h = 760, 8
    x0 = (W - w) / 2
    d.rounded_rectangle([x0, y, x0 + w, y + h], radius=4, fill=(40, 58, 78))
    d.rounded_rectangle([x0, y, x0 + w * clamp(p), y + h], radius=4, fill=color)


# ── Audio: Rhythmus statt Sinus ------------------------------------------
def make_audio(dur, bpm=124, style="hook"):
    """Rythmische Basis statt weichem Pad — Plattformen belohnen
    schnelle Audio-Spuren, ein gehaltener Sinuston killt Retention."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    beat = 60.0 / bpm
    L = np.zeros(n)
    R = np.zeros(n)

    if style == "hook":
        # Vier-on-the-floor-Kick + Hihat + Basslinie
        for k in range(int(dur / beat) + 1):
            t0 = k * beat
            if t0 >= dur:
                break
            st = int(t0 * SR)
            ln = min(n - st, int(0.22 * SR))
            if ln <= 0:
                break
            env = np.exp(-np.linspace(0, 14, ln))
            f = 120 * np.exp(-np.linspace(0, 26, ln)) + 42
            body = np.sin(2 * np.pi * np.cumsum(f) / SR) * env
            L[st:st + ln] += body * 0.85
            R[st:st + ln] += body * 0.85
        # Hihat auf den Achteln
        for k in range(int(dur / (beat / 2)) + 1):
            t0 = k * beat / 2
            if t0 >= dur:
                break
            st = int(t0 * SR)
            ln = min(n - st, int(0.05 * SR))
            if ln <= 0:
                continue
            env = np.exp(-np.linspace(0, 45, ln))
            noise = np.random.default_rng(k).normal(0, 1, ln) * env
            hp = np.concatenate([[0], np.diff(noise)])
            g = 0.16 if k % 2 == 0 else 0.09
            L[st:st + ln] += hp * g
            R[st:st + ln] += hp * g
        # Bass-Akkordfolge, Dur, hell
        bass = [55.0, 55.0, 65.4, 49.0]
        for k in range(int(dur / beat) + 1):
            f = bass[(k // 2) % len(bass)]
            t0, t1 = k * beat, min(dur, (k + 1) * beat)
            st, ln = int(t0 * SR), int((t1 - t0) * SR)
            if ln <= 0:
                continue
            tt = np.arange(ln) / SR
            env = np.clip(np.linspace(0, 1, ln) * 8, 0, 1) * np.exp(-tt * 1.4)
            sig = (np.sin(2 * np.pi * f * tt) + 0.4 * np.sin(2 * np.pi * f * 2 * tt)) * env * 0.3
            L[st:st + ln] += sig
            R[st:st + ln] += sig
    elif style == "tick":
        # Schnelle Uhr-Ticks + hoher Puls: passt zu Zaehler/Zahl-Clips
        for k in range(int(dur / 0.25) + 1):
            st = int(k * 0.25 * SR)
            ln = min(n - st, int(0.04 * SR))
            if ln <= 0:
                break
            env = np.exp(-np.linspace(0, 60, ln))
            sig = np.sin(2 * np.pi * 1650 * np.arange(ln) / SR) * env * 0.13
            L[st:st + ln] += sig
            R[st:st + ln] += sig
        for k in range(int(dur / 0.5) + 1):
            st = int(k * 0.5 * SR)
            ln = min(n - st, int(0.5 * SR))
            if ln <= 0:
                break
            tt = np.arange(ln) / SR
            env = np.exp(-tt * 2.6)
            sig = (np.sin(2 * np.pi * 220 * tt) + np.sin(2 * np.pi * 330 * tt)) * env * 0.24
            L[st:st + ln] += sig
            R[st:st + ln] += sig

    elif style == "trap":
        # 808-Sub mit Pitch-Drop + Clap auf den Offbeats + schnelle 16tel-Hats.
        for k in range(int(dur / beat) + 1):
            t0 = k * beat
            if t0 >= dur:
                break
            st = int(t0 * SR)
            ln = min(n - st, int(0.9 * SR))
            if ln <= 0:
                break
            tt = np.arange(ln) / SR
            env = np.exp(-tt * 3.2)
            f = 49 * np.exp(-tt * 6.0) + 33
            sig = np.sin(2 * np.pi * np.cumsum(f) / SR) * env * 0.9
            L[st:st + ln] += sig
            R[st:st + ln] += sig
        for k in range(int(dur / beat) + 1):
            for frac, g in ((0.0, 0.5), (1.5, 0.85), (3.5, 0.85)):
                t0 = (k + frac) * beat
                if t0 >= dur:
                    continue
                st = int(t0 * SR)
                ln = min(n - st, int(0.14 * SR))
                if ln <= 0:
                    continue
                env = np.exp(-np.linspace(0, 30, ln))
                noise = np.random.default_rng(int(t0 * 1000)).normal(0, 1, ln) * env
                L[st:st + ln] += noise * g
                R[st:st + ln] += noise * g
        for k in range(int(dur / (beat / 4)) + 1):
            t0 = k * beat / 4
            if t0 >= dur:
                break
            st = int(t0 * SR)
            ln = min(n - st, int(0.03 * SR))
            if ln <= 0:
                continue
            env = np.exp(-np.linspace(0, 55, ln))
            hp = np.concatenate([[0], np.diff(np.random.default_rng(k * 7).normal(0, 1, ln))]) * env
            g = 0.11 if k % 2 == 0 else 0.06
            L[st:st + ln] += hp * g
            R[st:st + ln] += hp * g
    elif style == "pop":
        # Helles Dur-Arpeggio + Kick auf 1/3 + Clap auf 2/4.
        triad = [261.63, 329.63, 392.0, 523.25]
        for k in range(int(dur / (beat / 2)) + 1):
            t0 = k * beat / 2
            if t0 >= dur:
                break
            st = int(t0 * SR)
            ln = min(n - st, int(0.30 * SR))
            if ln <= 0:
                continue
            tt = np.arange(ln) / SR
            env = np.exp(-tt * 7.0) * np.clip(tt * 60, 0, 1)
            f = triad[k % len(triad)]
            sig = (np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(2 * np.pi * f * 2 * tt)) * env * 0.30
            L[st:st + ln] += sig
            R[st:st + ln] += sig
        for k in range(int(dur / beat) + 1):
            for frac in (0.0, 2.0):
                t0 = (k + frac) * beat
                if t0 >= dur:
                    continue
                st = int(t0 * SR)
                ln = min(n - st, int(0.20 * SR))
                if ln <= 0:
                    continue
                tt = np.arange(ln) / SR
                env = np.exp(-np.linspace(0, 20, ln))
                body = np.sin(2 * np.pi * (130 * np.exp(-tt * 22) + 46) * tt) * env
                L[st:st + ln] += body * 0.8
                R[st:st + ln] += body * 0.8
            for frac in (1.0, 3.0):
                t0 = (k + frac) * beat
                if t0 >= dur:
                    continue
                st = int(t0 * SR)
                ln = min(n - st, int(0.13 * SR))
                if ln <= 0:
                    continue
                env = np.exp(-np.linspace(0, 28, ln))
                noise = np.random.default_rng(int(t0 * 777)).normal(0, 1, ln) * env
                L[st:st + ln] += noise * 0.7
                R[st:st + ln] += noise * 0.7
    elif style == "epic":
        # Ansteigender Moll-Pad + wachsender Kick-Puls + Drop bei ~60 %.
        drop = 0.6 * dur
        tt_all = np.arange(n) / SR
        grow = np.clip(tt_all / max(1e-3, drop), 0, 1)
        pad = sum(np.sin(2 * np.pi * fr * tt_all) for fr in (110.0, 164.81, 220.0)) * 0.10 * grow
        L += pad
        R += pad
        for k in range(int(dur / beat) + 1):
            t0 = k * beat
            if t0 >= dur:
                break
            st = int(t0 * SR)
            ln = min(n - st, int(0.25 * SR))
            if ln <= 0:
                break
            tt = np.arange(ln) / SR
            env = np.exp(-np.linspace(0, 16, ln))
            g = 0.5 + 0.5 * min(1.0, t0 / max(1e-3, drop))
            body = np.sin(2 * np.pi * (120 * np.exp(-tt * 24) + 40) * tt) * env
            L[st:st + ln] += body * g
            R[st:st + ln] += body * g
        st = int(drop * SR)
        ln = min(n - st, int(1.2 * SR))
        if ln > 0:
            tt = np.arange(ln) / SR
            env = np.exp(-tt * 2.2)
            hit = (np.sin(2 * np.pi * 82.41 * tt) + 0.5 * np.sin(2 * np.pi * 164.81 * tt)) * env * 0.6
            L[st:st + ln] += hit
            R[st:st + ln] += hit

    peak = max(1e-9, np.abs(np.concatenate([L, R])).max())
    L, R = L / peak * 0.88, R / peak * 0.88
    out = np.stack([L, R], axis=1)
    pcm = (out * 32767).astype(np.int16)
    return pcm.tobytes()


def write_video(frames_dir, out, dur, audio_pcm, fps=FPS):
    silent = os.path.join(frames_dir, "_s.mp4")
    subprocess.run([
        "ffmpeg", "-y", "-framerate", str(fps), "-i", os.path.join(frames_dir, "f%04d.png"),
        # crf 28 + kurze GOP: Cloudflare Assets haelt 25 MiB pro Datei ein.
        # Grain-Filmkorn kostet Bitrate, deshalb bewusst moderat komprimiert.
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "28",
        "-g", "60", "-movflags", "+faststart", silent
    ], check=True, capture_output=True)
    wav = os.path.join(frames_dir, "_a.wav")
    import wave as wavemod
    with wavemod.open(wav, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(audio_pcm)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    subprocess.run([
        "ffmpeg", "-y", "-i", silent, "-i", wav,
        "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", out
    ], check=True, capture_output=True)
    return out


LOOP_TAIL = 0.5


def render(name, slug, dur, fn, audio_style="hook", bpm=124,
           lang="de", suffix="", place=None, loop=False):
    tmp = tempfile.mkdtemp(prefix=f"concept_{name}")
    fd = os.path.join(tmp, "frames")
    os.makedirs(fd)
    set_font_lang(lang)
    world = load_map()
    nframes = int(dur * FPS)
    for i in range(nframes):
        t = i / FPS
        im = fn(world, t, dur, i, place, lang)
        im.convert("RGB").save(os.path.join(fd, f"f{i:04d}.png"))
    adur = dur
    if loop:
        tail = int(round(LOOP_TAIL * FPS))
        first = Image.open(os.path.join(fd, "f0000.png")).convert("RGB")
        last = Image.open(os.path.join(fd, f"f{nframes - 1:04d}.png")).convert("RGB")
        for k in range(1, tail + 1):
            p = k / (tail + 1)
            Image.blend(last, first, p).save(
                os.path.join(fd, f"f{nframes - 1 + k:04d}.png"))
        adur = dur + LOOP_TAIL
    out = os.path.join(OUT, f"c{name}-{slug}{suffix}.mp4")
    write_video(fd, out, adur, make_audio(adur, bpm, audio_style))
    print(f"  {os.path.basename(out)}  ({adur}s, {lang}{' loop' if loop else ''})")
    return out


# ══ Sprachen ═══════════════════════════════════════════════════════════
# Alle sieben Sprachen sind lateinisch, Avenir Next deckt sie ab. Bei einer
# Devanagari-Sprache (Hindi) muesste hier ein Devanagari-Font dazukommen,
# sonst rendert der Text als Ersatzkasten.
I18N = {
    "de": dict(head="DEIN ORT.", px="PIXEL", cert="ZERTIFIKAT",
               country="Finnland",
               yours="Dein Zuhause", forever="für 1 € kaufen", or_="ODER",
               coffee="Ein Kaffee", gone="weg in 20 Minuten"),
    "en": dict(head="YOUR PLACE.", px="PIXEL", cert="CERTIFICATE",
               country="Finland",
               yours="Your Home", forever="buy it for €1", or_="OR",
               coffee="One coffee", gone="gone in 20 minutes"),
    "es": dict(head="TU LUGAR.", px="PÍXEL", cert="CERTIFICADO",
               country="Finlandia",
               yours="Tu hogar", forever="cómpralo por 1 €", or_="O",
               coffee="Un café", gone="se va en 20 minutos"),
    "fr": dict(head="TA PLACE.", px="PIXEL", cert="CERTIFICAT",
               country="Finlande",
               yours="Ta maison", forever="achète-la pour 1 €", or_="OU",
               coffee="Un café", gone="part en 20 minutes"),
    "it": dict(head="IL TUO LUOGO.", px="PIXEL", cert="CERTIFICATO",
               country="Finlandia",
               yours="La tua casa", forever="comprala a 1 €", or_="O",
               coffee="Un caffè", gone="via via in 20 minuti"),
    "pt": dict(head="SEU LUGAR.", px="PÍXEL", cert="CERTIFICADO",
               country="Finlândia",
               yours="A tua casa", forever="compra por 1 €", or_="OU",
               coffee="Um café", gone="some em 20 minutos"),
    "tr": dict(head="SENİN YERİN.", px="PİKSEL", cert="BELGE",
               country="Finlandiya",
               yours="Evin", forever="1 € ile al", or_="VEYA",
               coffee="Bir kahve", gone="20 dakikada gider"),
    "ru": dict(head="ТВОЁ МЕСТО.", px="ПИКСЕЛЬ", cert="СЕРТИФИКАТ",
               country="Финляндия",
               yours="Твой дом", forever="купи за 1 €", or_="ИЛИ",
               coffee="Одна чашка кофе", gone="исчезнет через 20 минут"),
    "hi": dict(head="तुम्हारी जगह।", px="पिक्सेल", cert="प्रमाणपत्र",
               country="फ़िनलैंड",
               yours="तुम्हारा घर", forever="1 यूरो में खरीदो", or_="या",
               coffee="एक कॉफ़ी", gone="20 मिनट में गया"),
    "zh": dict(head="你的地方。", px="像素", cert="证书",
               country="芬兰",
               yours="你的家", forever="1 欧元买下", or_="或",
               coffee="一杯咖啡", gone="20 分钟就没了"),
}
LANGS = list(I18N.keys())


def T(lang):
    """Sprachtabelle mit Fallback auf Deutsch."""
    return I18N.get(lang, I18N["de"])


# ── Erste Frame: A/B-Varianten ─────────────────────────────────────────
# Messung (Buffer, 30 Tage): 2159 Views auf 43 Posts, 7 Reaktionen,
# 0 Kommentare, 0 Views auf TikTok. Der auffaelligste Post ist "What if
# 1 billion people..." mit 949 Views - also eine Frage im ersten Frame.
# Daraus zwei Varianten: (a) die Frage, (b) der Besitz.
HEAD_VARIANTS = {
    "q": {"de": "1 MILLIARDE\nFRAGEN?", "en": "1 BILLION\nQUESTIONS?",
          "es": "1 MILLION\nDE PREGUNTAS?", "fr": "1 MILLIARD\nDE QUESTIONS ?",
          "it": "1 MILIARDO\nDI DOMANDE?", "pt": "1 BILH\u00c3O\nDE PERGUNTAS?",
          "tr": "1 M\u0130LYAR\nSORU?",
          "ru": "1 МЛРД\nВОПРОСОВ?", "hi": "10 अरब\nसवाल?", "zh": "10亿\n个问题？"},
    "own": {"de": "DEIN HAUS.\n1 \u20ac.", "en": "YOUR HOUSE.\n\u20ac1.",
            "es": "TU CASA.\n1 \u20ac.", "fr": "TA MAISON.\n1 \u20ac.",
            "it": "LA TUA CASA.\n1 \u20ac.", "pt": "A TUA CASA.\n1 \u20ac.",
            "tr": "SEN\u0130N EV\u0130N.\n1 \u20ac.",
            "ru": "ТВОЙ ДОМ.\n1 €.", "hi": "तुम्हारा घर।\n1 यूरो।", "zh": "你的房子。\n1 欧元。"},
}
HEAD_VARIANT = os.environ.get("HEAD_VARIANT", "own")


def head_text(lang, variant=None):
    v = variant or HEAD_VARIANT
    return HEAD_VARIANTS.get(v, HEAD_VARIANTS["own"])[lang]


# ══ Konzept 1: Der Beweis — v4 ══════════════════════════════════════════
# Reduziert auf drei Beats, je hoechstens zwei Textzeilen, alles im unteren
# Drittel. Das Zertifikat lebt ausschliesslich in der Kartenhälfte
# (y < 1080) und kann den Text deshalb nicht mehr ueberdecken.
CERT_TOP, CERT_BOT = 360, 1080

COLS, ROWS = 40000, 25000


def geo_to_id(lat, lon):
    """Dieselbe Formel wie in src/worker.js — damit die Nummer im Zertifikat
    echt ist und nicht frei erfunden."""
    clat = max(-90.0, min(90.0, float(lat)))
    x = (((float(lon) + 180.0) / 360.0) % 1 + 1) % 1
    col = min(COLS - 1, int(x * COLS))
    row = min(ROWS - 1, max(0, int(((90.0 - clat) / 180.0) * ROWS)))
    return row * COLS + col


class Place:
    """Ein Ort als eine einzige Quelle der Wahrheit.

    Vorher waren Koordinaten, Stadtname und Pixel-Nummer an drei Stellen
    getrennt hinterlegt — sie konnten auseinanderlaufen (tatsaechlich:
    #201383535 gehoerte zu gar keinem der beiden Orte)."""

    def __init__(self, lat, lon, city, country):
        self.lat, self.lon = lat, lon
        self.city, self.country = city, country      # country = deutsche Form
        self.pixel_id = geo_to_id(lat, lon)
        self.coord = f"{abs(lat):.4f}°{'N' if lat >= 0 else 'S'}  {abs(lon):.4f}°{'E' if lon >= 0 else 'W'}"

    def place(self, lang="de"):
        return f"{self.city}, {T(lang)['country']}"

    def label(self, lang="de"):
        return f"{T(lang)['px']} #{self.pixel_id}"


C1_PLACE = Place(60.1699, 24.9384, "Helsinki", "Finnland")


def c1_text_rows(t, place=None, lang="de"):
    """(zeilen, beat) — welche Textzeilen sind in diesem Frame aktiv."""
    p = place or C1_PLACE
    L = T(lang)
    if t < 1.9:
        head = head_text(lang)
        if "\n" in head:            # zweizeilig: als zwei gestapelte Zeilen
            a_, b_ = head.split("\n", 1)
            return [(0, 76, "bold", WHITE, a_),
                    (1, 76, "bold", GREEN, b_)], 1
        return [(0, 92, "bold", WHITE, head)], 1
    if t < 3.9:
        return [(0, 84, "bold", WHITE, p.coord),
                (1, 40, "demi", GREEN, p.label(lang))], 2
    # Preiszeile: Devanagari hat kein '€' -> dort das Wort "यूरो".
    price = "1 यूरो" if lang == "hi" else "1 €"
    return [(0, 104, "bold", GREEN, price)], 3


def c1_proof(world, t, dur, fi, place=None, lang="de"):
    p = place or C1_PLACE
    lat, lon = p.lat, p.lon
    src2x = world.resize((W * 2, W * 2), Image.LANCZOS)

    # Karte: Anflug aus der Weltansicht, danach ruhiges Atmen.
    # Zoom 1.0 -> 2.3 statt 4.2. Bei 4.2 war der Ausschnitt so eng, dass die
    # Karte nur noch als unscharfe Textur las und kein Ort mehr erkennbar war.
    z = 1.0 + 1.3 * ease_in_out(clamp(t / 1.9))
    if t > 1.9:
        z *= 1.0 + 0.04 * math.sin((t - 1.9) * 1.5)
    half = int((W / z) / 2)
    pad = int(half * 0.28)
    drift = 0.0 if t < 1.9 else math.sin((t - 1.9) * 1.1) * 9
    cx = (lon + 180.0) / 360.0 * (W * 2) + drift
    cy = (90.0 - lat) / 180.0 * (W * 2)
    box = (int(cx - half - pad), int(cy - half - pad),
           int(cx + half + pad), int(cy + half + pad))
    im = src2x.crop(box).resize((W, H), Image.LANCZOS).convert("RGBA")
    px, py = latlon_to_px(lat, lon, box)

    # Pixel fuellt sich ab 1.35 und pulsiert.
    if t > 1.35:
        f = ease_out(clamp((t - 1.35) / 0.4))
        r = 22 + 32 * f
        pulse = 1 + 0.10 * math.sin((t - 1.75) * 5.2) if t > 1.75 else 1.0
        rr = int(r * pulse)
        im = Image.alpha_composite(im, glow_layer(im.size, px, py, int(rr * 2.7),
                                                   GREEN, int(170 * f)))
        dd = ImageDraw.Draw(im)
        dd.rounded_rectangle([px - rr, py - rr, px + rr, py + rr], radius=8,
                             outline=(150, 245, 210, int(200 * f)), width=4)
        dd.rounded_rectangle([px - int(rr * .62), py - int(rr * .62),
                              px + int(rr * .62), py + int(rr * .62)], radius=6,
                             fill=GREEN + (255,), outline=(228, 255, 245, 255), width=3)

    # Zertifikat: nur in der oberen Haelfte, erscheint ab 3.6.
    if t > 3.6:
        u = ease_out(clamp((t - 3.6) / 0.7))
        cw, ch = 620, 430
        card = Image.new("RGBA", (cw, ch), (11, 19, 32, 248))
        cd = ImageDraw.Draw(card)
        cd.rounded_rectangle([0, 0, cw - 1, ch - 1], radius=20,
                             outline=GREEN + (215,), width=4)
        cd.rounded_rectangle([0, 0, int(cw * u), 8], radius=4, fill=GREEN)
        cd.text((44, 44), T(lang)["cert"], font=font(34, "bold"), fill=CYAN)
        cd.text((44, 104), p.label(lang), font=font(54, "bold"), fill=WHITE)
        cd.text((44, 258), p.place(lang), font=font(40, "regular"), fill=SOFT)
        cd.rounded_rectangle([44, 336, 430, 400], radius=10, fill=GREEN + (42,))
        # Koordinate + Domain sind reine Latin-Strings; das Devanagari-Font
        # kennt das Gradzeichen '°' nicht -> immer in der Latin-Familie.
        prev_fam = cur_font_family()
        set_font_family("latin")
        cd.text((44, 196), p.coord, font=font(40, "regular"), fill=SOFT)
        cd.text((66, 350), "pixelmaps.org", font=font(36, "medium"), fill=GREEN)
        set_font_family(prev_fam)
        # karte dreht sich minimal ein, liegt aber immer streng in CERT_TOP..CERT_BOT
        card = card.rotate(-3 * (1 - u), resample=Image.BICUBIC, expand=False)
        sc = 0.9 + 0.1 * u
        card = card.resize((int(cw * sc), int(ch * sc)), Image.LANCZOS)
        cy = CERT_TOP + ((CERT_BOT - CERT_TOP) - card.size[1]) // 2
        mask = Image.new("L", card.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, card.size[0] - 1, card.size[1] - 1], radius=20, fill=int(255 * u))
        im.paste(card, (int(W / 2 - card.size[0] / 2), cy), mask)

    # Text: Verlauf erst ab y=1080, damit die Karte oben frei bleibt.
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    for i in range(1080, H):
        a = int(252 * ((i - 1080) / (H - 1080)) ** 1.5)
        od.rectangle([0, i, W, i], fill=BG + (a,))
    im = Image.alpha_composite(im, ov)
    im = badge(im)
    d = ImageDraw.Draw(im)

    rows, beat = c1_text_rows(t, p, lang)
    # Beat-Wechsel: alte Zeile faellt weg, neue kommt von unten.
    if t < 1.9:
        a_in = ease_out(clamp(t / 0.45))
    elif t < 3.9:
        a_in = ease_out(clamp((t - 1.9) / 0.4))
    else:
        a_in = ease_out(clamp((t - 3.9) / 0.4))
    pulse = 1 + (0.06 * math.sin((t - 4.4) * 6) if beat == 3 and t > 4.4 else 0.0)

    placed = []
    ys = stack_rows([pt for _, pt, _, _, _ in rows], base=1500)
    for (idx, pt, style, col, txt), (y, h) in zip(rows, ys):
        placed.append((y, h, txt))
        f = font(int(pt * (1 + pulse)), style)
        yy = y + int((1 - a_in) * 70)
        if idx == 0 and beat == 3:
            im = Image.alpha_composite(im, glow_layer(im.size, W / 2, y + h / 2,
                                                      240, GREEN, int(60 * a_in)))
            d = ImageDraw.Draw(im)
        d.text((W / 2 - d.textlength(txt, font=f) / 2, yy), txt, font=f,
               fill=col + (int(255 * a_in),))
    check_layout("c1", placed)
    progress_bar(d, clamp(t / dur), 1820, GREEN)
    return grain(im, 3, fi)


# ══ Konzept 2: Preisanker (PPP) ════════════════════════════════════════
# Lokaler Preis ist der staerkste Hook fuer die Nicht-EU-Zielgruppen.
def c2_price(world, t, dur, fi):
    im = base_canvas(world)
    im = ImageEnhance.Brightness(im).enhance(0.55).convert("RGBA")
    im = scrim(im, top=300, bottom=980, strength=248)
    im = badge(im)
    d = ImageDraw.Draw(im)

    markets = [
        ("Deutschland", "1 €", "1 Pixel"),
        ("Indien", "54,60 ₹", "1 Pixel"),
        ("Brasilien", "3,54 R$", "1 Pixel"),
    ]
    seg = dur / len(markets)
    idx = min(len(markets) - 1, int(t / seg))
    land, preis, was = markets[idx]
    local = t - idx * seg
    a = ease_out(min(1.0, local / 0.35))

    # Wechsel: alte Zeile faellt nach oben raus, neue kommt von unten
    def row(i, y, alpha, dy=0):
        l, p, w = markets[i]
        if alpha <= 0:
            return
        f_land = font(34, "medium")
        f_preis = font(112, "bold")
        f_was = font(30, "regular")
        yy = y + dy
        d.text((W / 2 - d.textlength(l, font=f_land) / 2, yy), l, font=f_land,
               fill=CYAN + (int(255 * alpha),))
        d.text((W / 2 - d.textlength(p, font=f_preis) / 2, yy + 54), p, font=f_preis,
               fill=GREEN + (int(255 * alpha),))
        d.text((W / 2 - d.textlength(w, font=f_was) / 2, yy + 186), w, font=f_was,
               fill=SOFT + (int(255 * alpha),))

    if local < 0.55:
        row(idx - 1 if idx > 0 else 0, 1260, max(0.0, 1 - local / 0.4), dy=int(-60 * local / 0.55))
    row(idx, 1260, a, dy=int(70 * (1 - a)))

    f_head = font(46, "bold")
    d.text((W / 2 - d.textlength("Dieselbe Karte.", font=f_head) / 2, 1130),
           "Dieselbe Karte.", font=f_head, fill=WHITE + (int(255 * a),))

    progress_bar(d, t / dur, 1810, GREEN)
    return grain(im, 3, fi)


# ══ Konzept 3: 3-Sekunden-Loop ═════════════════════════════════════════
# Ein Wort, das sich einbrennt, harter Schnitt zurueck zum Anfang.
# Kurze Clips bekommen mehr Zweitversuche.
def c3_loop(world, t, dur, fi):
    loop = 3.0
    k = t % loop
    im = base_canvas(world)
    im = ImageEnhance.Brightness(im).enhance(0.42).convert("RGBA")
    im = ImageEnhance.Contrast(im).enhance(1.3).convert("RGBA")
    im = scrim(im, top=420, bottom=1020, strength=252)
    im = badge(im)
    d = ImageDraw.Draw(im)

    beat = loop / 3
    b = int(k / beat)
    words = ["1 €", "1 PIXEL", "DEINS"]
    # Wort skaliert kurz und faellt dann zurueck -> Loop-Gefuehl
    pop = 1 + 0.22 * math.exp(-((k - b * beat) / 0.22) ** 2)
    a = min(1.0, k / 0.12)

    f = font(150, "bold")
    s = words[b]
    tw = d.textlength(s, font=f)
    im2 = im
    if pop > 1.02:
        nw, nh = int(W * pop), int(H * pop)
        tmp = Image.new("RGBA", (nw, nh), (0, 0, 0, 0))
        tmp.paste(im, (int((nw - W) / 2), int((nh - H) / 2)))
        im2 = tmp.crop((int((nw - W) / 2), int((nh - H) / 2),
                        int((nw - W) / 2) + W, int((nh - H) / 2) + H))
    im = im2
    d = ImageDraw.Draw(im)
    glow = glow_layer(im.size, W / 2, 980, 340, GREEN, 70)
    im = Image.alpha_composite(im, glow)
    d = ImageDraw.Draw(im)
    d.text((W / 2 - tw / 2, 900), s, font=f, fill=GREEN + (int(255 * a),))

    f2 = font(34, "medium")
    d.text((W / 2 - d.textlength("pixelmaps.org", font=f2) / 2, 1090),
           "pixelmaps.org", font=f2, fill=SOFT + (int(255 * a),))
    progress_dots(d, 3, b, 1740)
    return grain(im, 3, fi)


# ══ Konzept 4: Zaehler / Rekord ════════════════════════════════════════
# Konkurrenz erzeugt Scroll-Stopp. Zahlen wachsen sichtbar.
def c4_counter(world, t, dur, fi):
    im = base_canvas(world)
    im = ImageEnhance.Brightness(im).enhance(0.5).convert("RGBA")
    im = scrim(im, top=380, bottom=1120, strength=250)
    im = badge(im)
    d = ImageDraw.Draw(im)

    total = 1_000_000_000
    p = ease_out(min(1.0, t / (dur - 1.2)))
    sold = 14
    cur = int(total * p * 0.02)
    left = total - sold

    f_head = font(38, "medium")
    draw_tracked(d, "WELTKARTE IN EINZELNEN KAELTEN", f_head, W / 2, 1180, CYAN, 5)

    def big(v, y, fill, size=124):
        s = f"{v:,}".replace(",", ".")
        fo = font(size, "bold")
        d.text((W / 2 - d.textlength(s, font=fo) / 2, y), s, font=fo, fill=fill)

    big(cur, 1250, WHITE)
    f_sep = font(44, "regular")
    d.text((W / 2 - d.textlength("verkaufte Pixel", font=f_sep) / 2, 1392),
           "verkaufte Pixel", font=f_sep, fill=SOFT)

    f_rem = font(30, "regular")
    s2 = f"{left:,}".replace(",", ".") + " frei"
    d.text((W / 2 - d.textlength(s2, font=f_rem) / 2, 1470), s2, font=f_rem, fill=DIM)

    if t > dur - 1.6:
        a = ease_out(min(1.0, (t - (dur - 1.6)) / 0.4))
        f_cta = font(58, "bold")
        s3 = "Deiner ist der nächste."
        d.text((W / 2 - d.textlength(s3, font=f_cta) / 2, 1600), s3, font=f_cta,
               fill=GREEN + (int(255 * a),))
    progress_bar(d, p, 1810, CYAN)
    return grain(im, 3, fi)


# ══ Konzept 5: Zwei Pixel, Dialog — v3 ══════════════════════════════════
# Aufgeraeumt: pro Haelfte genau EIN Textblock (Wort + Preis). Die frueher
# zusaetzlich eingeblendete CTA-Zeile raus, das Raster leiser, Tasse ohne
# Ueberlagerung durch den eigenen Text.
def c5_dialog(world, t, dur, fi, place=None, lang="de"):
    p = place or C1_PLACE
    L = T(lang)
    split = int(H * 0.50)
    src2x = world.resize((W * 2, W * 2), Image.LANCZOS)

    # ── oben: echte Kamerafahrt, Pixel fuellt sich ────────────────────
    # Gleicher Zoom-Endwert wie c1 (2.3) — sonst wirkt die Karte nur hier
    # uebermagnifiziert und die beiden Clips wirken nicht wie dieselbe Welt.
    z = 1.0 + 1.3 * ease_in_out(clamp(t / 1.8))
    if t > 1.8:
        z *= 1.0 + 0.045 * math.sin((t - 1.8) * 1.6)
    half = int((W / z) / 2)
    pad = int(half * 0.26)
    lat, lon = p.lat, p.lon
    drift = 0.0 if t < 1.8 else math.sin((t - 1.8) * 1.2) * 10
    cx = (lon + 180.0) / 360.0 * (W * 2) + drift
    cy = (90.0 - lat) / 180.0 * (W * 2)
    box = (int(cx - half - pad), int(cy - half - pad), int(cx + half + pad), int(cy + half + pad))
    top = src2x.crop(box).resize((W, split), Image.LANCZOS).convert("RGBA")
    top = ImageEnhance.Brightness(top).enhance(0.86)

    # Text sitzt im unteren Drittel der oberen Haelfte, mit eigenem Verlauf
    top_rows_top = split - 300
    tov = Image.new("RGBA", (W, split), (0, 0, 0, 0))
    td0 = ImageDraw.Draw(tov)
    for i in range(top_rows_top, split):
        a = int(250 * ((i - top_rows_top) / (split - top_rows_top)) ** 1.4)
        td0.rectangle([0, i, W, i], fill=BG + (a,))
    top = Image.alpha_composite(top, tov)

    if t > 1.15:
        f = ease_out(clamp((t - 1.15) / 0.4))
        px, py = latlon_to_px(lat, lon, box)
        py = py * split / H
        r = 18 + 28 * f
        pulse = 1 + 0.10 * math.sin((t - 1.55) * 5.0) if t > 1.55 else 1.0
        rr = int(r * pulse)
        top = Image.alpha_composite(top, glow_layer(top.size, px, py, int(rr * 2.5),
                                                     GREEN, int(165 * f)))
        td = ImageDraw.Draw(top)
        td.rounded_rectangle([px - rr, py - rr, px + rr, py + rr], radius=8,
                             fill=GREEN + (255,), outline=(228, 255, 245, 255), width=3)

    # ── unten: ruhiger Grund, Tasse dampft und faehrt raus ────────────
    bot = Image.new("RGBA", (W, H - split), BG + (255,))
    bd = ImageDraw.Draw(bot)
    off = int((t * 34) % 96)
    for gy in range(-96, H, 96):
        bd.line([0, gy - off, W, gy - off], fill=(70, 220, 255, 10), width=2)

    cup_a = ease_out(clamp(t / 0.45))
    cup_out = ease_in_out(clamp((t - 1.6) / 1.6))
    cup_x = int(W * 0.5 + cup_out * W * 0.9)
    cup_y = 150 - int(cup_out * 90)
    al = int(255 * cup_a * (1 - cup_out * 0.9))
    if al > 8:
        rr_c = 78
        bd.ellipse([cup_x - rr_c, cup_y - rr_c * .78, cup_x + rr_c, cup_y + rr_c * .78],
                   outline=AMBER + (al,), width=9)
        bd.arc([cup_x + rr_c * .5, cup_y - rr_c * .5, cup_x + rr_c * 1.5, cup_y + rr_c * .5],
               -80, 80, fill=AMBER + (al,), width=9)
        for s_i in range(3):
            ph = (t * 0.85 + s_i * 0.33) % 1.0
            sy_ = cup_y - rr_c - ph * 170
            sxx = cup_x + math.sin(ph * 7 + s_i) * 24
            sr = int(9 + ph * 15)
            bd.ellipse([sxx - sr, sy_ - sr, sxx + sr, sy_ + sr],
                       fill=(200, 220, 240, int(60 * (1 - ph) * (al / 255))))

    im = Image.new("RGBA", (W, H), BG + (255,))
    im.paste(top, (0, 0))
    im.paste(bot, (0, split))
    d = ImageDraw.Draw(im)

    # Trennlinie: pulsierend, aber schmal.
    lum = 0.5 + 0.5 * math.sin(t * 3.0)
    d.rectangle([0, split - 2, W, split + 2], fill=GREEN + (int(255 * lum),))
    f_o = font(38, "bold")
    wo = L["or_"]
    bw = int(d.textlength(wo, font=f_o)) + 66
    d.rounded_rectangle([W / 2 - bw / 2, split - 30, W / 2 + bw / 2, split + 30],
                        radius=20, fill=BG + (255,))
    d.text((W / 2 - d.textlength(wo, font=f_o) / 2, split - 24), wo, font=f_o,
           fill=GREEN + (int(255 * lum),))

    # ── oben genau ein Block: Wort + Preis ────────────────────────────
    a = ease_out(clamp(t / 0.45))
    (y1, h1), (y2, h2) = stack_rows([96, 46], base=split - 70)
    check_layout("c5/oben", [(y1, h1, "Wort"), (y2, h2, "Preis")])
    d.text((W / 2 - d.textlength(L["yours"], font(96, "bold")) / 2, y1),
           L["yours"], font=font(96, "bold"), fill=WHITE + (int(255 * a),))
    d.text((W / 2 - d.textlength(L["forever"], font(46, "demi")) / 2, y2),
           L["forever"], font=font(46, "demi"), fill=GREEN + (int(255 * a),))

    # ── unten genau ein Block, folgt der Tasse ────────────────────────
    a2 = ease_out(clamp((t - 0.9) / 0.45))
    fade = int(255 * a2 * (1 - cup_out * 0.8))
    (y3, h3), (y4, h4) = stack_rows([88, 42], base=split + 430)
    y3 -= int(cup_out * 60)
    y4 -= int(cup_out * 60)
    check_layout("c5/unten", [(y3, h3, "Kaffee"), (y4, h4, "weg")])
    if fade > 8:
        d.text((W / 2 - d.textlength(L["coffee"], font(88, "bold")) / 2, y3),
               L["coffee"], font=font(88, "bold"), fill=WHITE + (fade,))
        d.text((W / 2 - d.textlength(L["gone"], font(42, "demi")) / 2, y4),
               L["gone"], font=font(42, "demi"), fill=AMBER + (fade,))

    # PIXELMAPS.ORG als Badge. c1 bis c4 setzen ihn, c5 nicht - damit blieb
    # in diesem Clip die einzige Handlungsaufforderung komplett weg, obwohl
    # hier ueber ein "Zuhause" verkauft wird. Ohne Domain ist die Aussage
    # nur eine Behauptung.
    im = badge(im)

    progress_bar(d, clamp(t / dur), 1820, GREEN)
    return grain(im, 3, fi)


# ══ Konzept 6: Vorher/Nachher-Split ════════════════════════════════════
# Zwei Kacheln nebeneinander: links der leere Punkt (VORHER), rechts der
# gekaufte Pixel (NACHHER). Der Gegensatz ist in unter 1 Sekunde lesbar und
# die Preis-Ebene ("1 €") braucht keine Sprachkenntnis - Text traegt nur Detail.
T6 = {
    "de": dict(before="VORHER", after="NACHHER",
               empty="Leerer Punkt", yours="Dein Pixel",
               sub="Dein Name · dein Ort · für immer"),
    "en": dict(before="BEFORE", after="AFTER",
               empty="Empty spot", yours="Your pixel",
               sub="Your name · your place · forever"),
    "es": dict(before="ANTES", after="DESPUÉS",
               empty="Punto vacío", yours="Tu píxel",
               sub="Tu nombre · tu lugar · para siempre"),
    "fr": dict(before="AVANT", after="APRÈS",
               empty="Point vide", yours="Ton pixel",
               sub="Ton nom · ton lieu · pour toujours"),
    "it": dict(before="PRIMA", after="DOPO",
               empty="Punto vuoto", yours="Il tuo pixel",
               sub="Il tuo nome · il tuo luogo · per sempre"),
    "pt": dict(before="ANTES", after="DEPOIS",
               empty="Ponto vazio", yours="O teu pixel",
               sub="O teu nome · o teu lugar · para sempre"),
    "tr": dict(before="ÖNCE", after="SONRA",
               empty="Boş nokta", yours="Pikselin",
               sub="Adın · yerin · sonsuza kadar"),
    "ru": dict(before="ДО", after="ПОСЛЕ",
               empty="Пустое место", yours="Твой пиксель",
               sub="Твоё имя · место · навсегда"),
    "hi": dict(before="पहले", after="बाद में",
               empty="खाली जगह", yours="तुम्हारा पिक्सेल",
               sub="नाम • जगह • हमेशा के लिए"),
    "zh": dict(before="之前", after="之后",
               empty="空白点", yours="你的像素",
               sub="名字 · 地方 · 永远"),
}


def c6_fit_text(d, text, max_w, style, start):
    """Schrumpft die Schriftgröße, bis der Text in max_w passt (CJK/Hindi
    sind breiter als Latein und laufen sonst aus dem Bild)."""
    pt = start
    while pt > 22:
        f = font(int(pt), style)
        if d.textlength(text, font=f) <= max_w:
            return f
        pt -= 2
    return font(22, style)


def c6_split(world, t, dur, fi, place=None, lang="de"):
    p = place or C1_PLACE
    L = T6.get(lang, T6["de"])
    src2x = world.resize((W * 2, W * 2), Image.LANCZOS)
    z = 1.0 + 0.9 * ease_in_out(clamp(t / 1.6))
    half = int((W / z) / 2)
    pad = int(half * 0.30)
    cx = (p.lon + 180.0) / 360.0 * (W * 2)
    cy = (90.0 - p.lat) / 180.0 * (W * 2)
    box = (int(cx - half - pad), int(cy - half - pad),
           int(cx + half + pad), int(cy + half + pad))
    scene = src2x.crop(box).resize((W, H), Image.LANCZOS).convert("RGB")
    bg = ImageEnhance.Brightness(scene).enhance(0.42)
    bg = bg.filter(ImageFilter.GaussianBlur(7)).convert("RGBA")
    im = bg

    d = ImageDraw.Draw(im)
    tw, th, ty = 400, 400, 500
    lx, rx = 100, W - 100 - tw

    for x0, word, col in ((lx, L["before"], DIM), (rx, L["after"], GREEN)):
        f = c6_fit_text(d, word, tw, "bold", 44)
        d.text((x0 + (tw - d.textlength(word, font=f)) / 2, ty - 66),
               word, font=f, fill=col)

    # Linke Kachel: leeres Feld
    d.rounded_rectangle([lx, ty, lx + tw, ty + th], radius=26,
                        outline=(90, 115, 140), width=5)
    qf = font(190, "bold")
    d.text((lx + (tw - d.textlength("?", font=qf)) / 2, ty + th / 2 - 150),
           "?", font=qf, fill=(90, 115, 140))

    # Rechte Kachel: gekaufter Pixel (Scale + Glow beim Erscheinen)
    u = ease_out(clamp((t - 1.15) / 0.55))
    pulse = 1 + (0.04 * math.sin((t - 1.7) * 5.4) if t > 1.7 else 0)
    if u > 0.001:
        gap = int((1 - u) * 90)
        im = Image.alpha_composite(im, glow_layer(
            im.size, rx + tw / 2, ty + th / 2, int(230 * u), GREEN, int(150 * u)))
        d = ImageDraw.Draw(im)
        d.rounded_rectangle([rx + gap, ty + gap, rx + tw - gap, ty + th - gap],
                            radius=26, fill=GREEN + (int(255 * u),),
                            outline=(228, 255, 245, int(255 * u)), width=5)
        s = tw * 0.34
        ix, iy = rx + tw / 2 - s / 2, ty + th / 2 - s / 2 - 24
        d.rounded_rectangle([ix, iy, ix + s, iy + s], radius=8,
                            fill=(5, 60, 45, int(230 * u)))
        pf = font(int(96 * pulse), "bold")
        # Preis liegt in jeder Sprache identisch vor -> immer lateinisch
        # zeichnen ("€" fehlt im Devanagari-Font und wuerde als Tofu erscheinen).
        draw_latin(d, "1 €", rx + tw / 2, ty + th - 118, int(96 * pulse), "bold",
                   (5, 40, 30, int(255 * u)))

    # Pfeil in der Mitte (gezeichnet - keine Glyphenabhaengigkeit)
    lum = 0.55 + 0.45 * math.sin(t * 3.2)
    acx, acy = W / 2, ty + th / 2
    acol = GREEN + (int(255 * lum),)
    d.line([acx - 34, acy, acx + 22, acy], fill=acol, width=10)
    d.polygon([(acx + 22, acy - 24), (acx + 22, acy + 24), (acx + 54, acy)], fill=acol)

    for x0, word in ((lx, L["empty"]), (rx, L["yours"])):
        f = c6_fit_text(d, word, tw + 40, "demi", 42)
        d.text((x0 + (tw - d.textlength(word, font=f)) / 2, ty + th + 34),
               word, font=f, fill=WHITE)

    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    for i in range(1150, H):
        a = int(252 * ((i - 1150) / (H - 1150)) ** 1.5)
        od.rectangle([0, i, W, i], fill=BG + (a,))
    im = Image.alpha_composite(im, ov)
    d = ImageDraw.Draw(im)

    a_sub = ease_out(clamp((t - 1.8) / 0.5))
    sf = c6_fit_text(d, L["sub"], 940, "demi", 56)
    d.text((W / 2 - d.textlength(L["sub"], font=sf) / 2, 1290),
           L["sub"], font=sf, fill=WHITE + (int(255 * a_sub),))
    draw_latin(d, "pixelmaps.org · 1 €", W / 2, 1380, 64, "bold",
               GREEN + (int(255 * a_sub),))

    im = badge(im)
    d = ImageDraw.Draw(im)
    check_layout("c6", [(ty - 66, 60, "eyebrow"), (ty + th + 34, 60, "label"),
                        (1290, 80, "sub"), (1380, 90, "cta")])
    progress_bar(d, clamp(t / dur), 1820, GREEN)
    return grain(im, 3, fi)


# ══ Konzepte ═══════════════════════════════════════════════════════════
CONCEPTS = [
    (1, "proof", 6.0, c1_proof, "hook", 132),
    (2, "price-anchor", 6.6, c2_price, "tick", 100),
    (3, "loop-3s", 6.0, c3_loop, "hook", 132),
    (4, "counter", 6.5, c4_counter, "tick", 96),
    (5, "dialog", 5.5, c5_dialog, "hook", 126),
    (6, "split", 6.0, c6_split, "pop", 120),
]

DESCRIPTIONS = {
    1: "Der Beweis — Karte fliegt ran, Pixel fuellt sich, Zertifikat kommt. Ein Ereignis statt einer Behauptung.",
    2: "Preisanker PPP — lokale Waehrung als Hook. Zielt auf die Nicht-EU-Zielgruppen der EN-Woche.",
    3: "3-Sekunden-Loop — ein Wort, harter Schnitt zurueck. Mehr Zweitversuche durch hohe Completion.",
    4: "Zaehler — Zahl waechst sichtbar, Konkurrenz erzeugt Scroll-Stopp.",
    5: "Zwei Pixel, Dialog — Split-Screen mit Preis-Konflikt.",
    6: "Vorher/Nachher-Split — leerer Punkt vs. gekaufter Pixel. In unter 1s lesbar, sprachunabhaengig ueber den Preis.",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--lang", default="de", choices=LANGS)
    ap.add_argument("--suffix", default="",
                    help="z.B. -en; leer laesst den deutschen Dateinamen unveraendert")
    ap.add_argument("--loop", action="store_true",
                    help="blendet das Ende in den Anfang (loopbar)")
    ap.add_argument("--music", default="",
                    help="Audio-Style ueberschreiben (hook/tick/trap/pop/epic)")
    ap.add_argument("--bpm", type=int, default=0)
    a = ap.parse_args()
    want = {int(x) for x in a.only.split(",") if x.strip()} if a.only else None

    os.makedirs(OUT, exist_ok=True)
    sel = [c for c in CONCEPTS if want is None or c[0] in want]
    print(f"Rendere {len(sel)} Konzept(e) -> {OUT}")
    made = []
    for name, slug, dur, fn, ast_, bpm in sel:
        print(f"\n[{DESCRIPTIONS[name]}]")
        ast_ = a.music or ast_
        bpm = a.bpm or bpm
        # c2/c3/c4 kennen kein place/lang-Argument – nur 1, 5 und 6 werden
        # uebersetzt, sonst wuerde der Aufruf einen TypeError werfen.
        if name in (1, 5, 6):
            made.append(render(str(name), slug, dur, fn, ast_, bpm,
                               lang=a.lang, suffix=a.suffix, loop=a.loop))
        else:
            if a.lang != "de":
                print("  (nur Konzept 1, 5 und 6 sind uebersetzt – uebersprungen)")
                continue
            made.append(render(str(name), slug, dur, fn, ast_, bpm))
    print("\nFERTIG:")
    for m in made:
        print("  " + m)


if __name__ == "__main__":
    main()