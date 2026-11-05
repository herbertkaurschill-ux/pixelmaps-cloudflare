#!/usr/bin/env python3
"""
youtube_explainer.py – langes Erklärvideo (16:9) für PixelMaps.

Im Gegensatz zu clipmap.py (9:16, 6 s, nur Musik) erzeugt dieses Skript ein
YouTube-taugliches Querformat-Video mit:
  - Sprecher-Stimme (edge-tts-Neuralstimme oder offline macOS `say`)
  - prozeduraler Hintergrundmusik (aus clipmap.py)
  - eingebrannten Untertiteln
  - Kamerafahrt über die echte Weltkarte
  - ehrlichen Zahlen (live von /api/stats, keine erfundenen Werte)
  - Deutsch oder Englisch (--lang de|en)

Nutzung:
  python3 scripts/youtube_explainer.py --out public/videos/pixelmaps-de.mp4 --lang de
  python3 scripts/youtube_explainer.py --out public/videos/pixelmaps-en.mp4 --lang en
  python3 scripts/youtube_explainer.py --out /tmp/test.mp4 --lang en --test
  python3 scripts/youtube_explainer.py --out ... --voice "Anna" --lang de
"""
import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clipmap as C  # noqa: E402  (Wiederverwendung der Karten-/Font-/Musik-Helfer)

VW, VH, FPS = 1920, 1080, 30
SR = 48000
SITE = "pixelmaps.org"
NAVY = (5, 9, 17)
CYAN = (120, 226, 255)
MINT = (86, 245, 200)
DIM = (150, 172, 194)

# ----------------------------------------------------------------------------
# Szenen: Text wird gesprochen UND als Untertitel gezeigt. Keine erfundenen
# Zahlen: verkaufte Pixel kommen live aus /api/stats.
# ----------------------------------------------------------------------------
SCENES_DE = [
    dict(
        id="intro",
        voice="Eine Milliarde Pixel. Ein einziger Planet.",
        head="1.000.000.000 Pixel",
        sub="Ein Planet. Eine gemeinsame Karte.",
        visual="intro",
        cam=[(0.50, 0.48, 1.00)],   # cx, cy, sichtbarer Anteil der Kartenbreite
        lead=0.35, tail=0.85,
    ),
    dict(
        id="idea",
        voice="Stell dir die Weltkarte vor, aufgeteilt in eine Milliarde kleine Kästchen.",
        head="Die Weltkarte, in 1 Milliarde Kästchen",
        sub="Jedes Kästchen ist ein echter Ort.",
        visual="dots",
        cam=[(0.50, 0.48, 0.86), (0.47, 0.45, 0.62)],
        lead=0.30, tail=0.60,
    ),
    dict(
        id="owner",
        voice="Jedes dieser Kästchen kann genau einer Person gehören.",
        head="Ein Kästchen. Eine Person.",
        sub="Dauerhaft, nicht gemietet.",
        visual="highlight",
        cam=[(0.52, 0.40, 0.44)],
        lead=0.30, tail=0.65,
    ),
    dict(
        id="choose",
        voice="Du suchst dir einen freien Punkt aus: deine Straße, deinen Lieblingsort, oder irgendwo mitten im Ozean.",
        head="Du wählst den Punkt",
        sub="Straße, Gipfel, Insel – ganz egal.",
        visual="pick",
        cam=[(0.52, 0.40, 0.30), (0.55, 0.52, 0.26)],
        lead=0.30, tail=0.60,
    ),
    dict(
        id="price",
        voice="Ein Euro. Einmal bezahlt, für immer deins. Kein Abo, keine Miete.",
        head="1 € · einmal · für immer",
        sub="Kein Abo. Keine Miete.",
        visual="price",
        cam=[(0.50, 0.46, 0.72)],
        lead=0.30, tail=0.65,
    ),
    dict(
        id="cert",
        voice="Dazu bekommst du eine Urkunde mit deinem Namen und deiner Pixel-Nummer.",
        head="Deine Urkunde",
        sub="Mit Name, Koordinaten und Pixel-Nummer.",
        visual="certificate",
        cam=[(0.50, 0.46, 0.80)],
        lead=0.30, tail=0.60,
    ),
    dict(
        id="race",
        voice="Auf der Karte siehst du, wer wo ist, und welches Land gerade vorne liegt.",
        head="Das Länder-Rennen",
        sub="Deutschland, Frankreich, USA, Brasilien, Japan …",
        visual="race",
        cam=[(0.50, 0.47, 0.55), (0.48, 0.44, 0.62)],
        lead=0.30, tail=0.60,
    ),
    dict(
        id="free",
        voice="Noch ist fast die ganze Karte frei. Dein Platz ist noch nicht vergeben.",
        head="Noch frei: {remaining}",
        sub="Dein Platz ist noch nicht vergeben.",
        visual="free",
        cam=[(0.50, 0.48, 0.96)],
        lead=0.30, tail=0.80,
    ),
    dict(
        id="cta",
        voice="Sichere dir deinen Pixel auf pixelmaps.org.",
        head="pixelmaps.org",
        sub="Sichere dir deinen Pixel.",
        visual="brand",
        cam=[(0.50, 0.46, 1.00)],
        lead=0.30, tail=1.30,
    ),
]

SCENES_EN = [
    dict(
        id="intro",
        voice="One billion pixels. One single planet.",
        head="1,000,000,000 pixels",
        sub="One planet. One shared map.",
        visual="intro",
        cam=[(0.50, 0.48, 1.00)],
        lead=0.35, tail=0.85,
    ),
    dict(
        id="idea",
        voice="Imagine the world map split into one billion tiny squares.",
        head="The world map, in 1 billion squares",
        sub="Every square is a real place.",
        visual="dots",
        cam=[(0.50, 0.48, 0.86), (0.47, 0.45, 0.62)],
        lead=0.30, tail=0.60,
    ),
    dict(
        id="owner",
        voice="Each of those squares can belong to exactly one person.",
        head="One square. One person.",
        sub="Permanent, not rented.",
        visual="highlight",
        cam=[(0.52, 0.40, 0.44)],
        lead=0.30, tail=0.65,
    ),
    dict(
        id="choose",
        voice="You pick a free spot: your street, your favorite place, or somewhere out in the ocean.",
        head="You pick the spot",
        sub="A street, a summit, an island. Anything.",
        visual="pick",
        cam=[(0.52, 0.40, 0.30), (0.55, 0.52, 0.26)],
        lead=0.30, tail=0.60,
    ),
    dict(
        id="price",
        voice="One euro. Paid once, yours forever. No subscription, no rent.",
        head="€1 · once · forever",
        sub="No subscription. No rent.",
        visual="price",
        cam=[(0.50, 0.46, 0.72)],
        lead=0.30, tail=0.65,
    ),
    dict(
        id="cert",
        voice="You also get a certificate with your name and your pixel number.",
        head="Your certificate",
        sub="With your name, coordinates and pixel number.",
        visual="certificate",
        cam=[(0.50, 0.46, 0.80)],
        lead=0.30, tail=0.60,
    ),
    dict(
        id="race",
        voice="On the map you can see who is where, and which country is currently ahead.",
        head="The country race",
        sub="Germany, France, USA, Brazil, Japan …",
        visual="race",
        cam=[(0.50, 0.47, 0.55), (0.48, 0.44, 0.62)],
        lead=0.30, tail=0.60,
    ),
    dict(
        id="free",
        voice="Right now, almost the whole map is still free. Your spot has not been taken yet.",
        head="Still free: {remaining}",
        sub="Your spot has not been taken yet.",
        visual="free",
        cam=[(0.50, 0.48, 0.96)],
        lead=0.30, tail=0.80,
    ),
    dict(
        id="cta",
        voice="Claim your pixel at pixelmaps.org.",
        head="pixelmaps.org",
        sub="Claim your pixel.",
        visual="brand",
        cam=[(0.50, 0.46, 1.00)],
        lead=0.30, tail=1.30,
    ),
]

SCENES = {"de": SCENES_DE, "en": SCENES_EN}

UI = {
    "de": dict(
        locale="de",
        header="1 Milliarde Pixel · 1 € pro Pixel",
        intro_line="Ein Planet. Eine Karte.",
        point="dein Punkt",
        price_caption="Euro · einmal zahlen · für immer",
        race=["Deutschland", "Frankreich", "USA", "Brasilien", "Japan", "Indien"],
        free_caption="Pixel noch frei",
        sold="vergeben",
        brand_cta="Sichere dir deinen Pixel.",
        cert_tag="BEISPIEL",
        cert_title="URKUNDE",
        cert_owner="Dieser Pixel gehört",
        cert_name="DEIN NAME",
        cert_number="Pixel-Nr. 123.456.789",
        cert_coords="Koordinaten 52.5200° N, 13.4050° E",
        default_voice="Anna",
    ),
    "en": dict(
        locale="en",
        header="1 billion pixels · €1 per pixel",
        intro_line="One planet. One map.",
        point="your spot",
        price_caption="euro · pay once · forever",
        race=["Germany", "France", "USA", "Brazil", "Japan", "India"],
        free_caption="pixels still free",
        sold="taken",
        brand_cta="Claim your pixel.",
        cert_tag="EXAMPLE",
        cert_title="CERTIFICATE",
        cert_owner="This pixel belongs to",
        cert_name="YOUR NAME",
        cert_number="Pixel no. 123,456,789",
        cert_coords="Coordinates 52.5200° N, 13.4050° E",
        default_voice="en-US-AriaNeural",
    ),
}

# Wird in main() gesetzt. Die Zeichen-Helfer lesen die aktive Sprache hieraus.
LANG = "de"
TXT = UI["de"]
STATS = {"total": 1_000_000_000, "sold": 0, "remaining": 1_000_000_000}


def set_lang(lang):
    global LANG, TXT
    LANG = lang
    TXT = UI[lang]
    _OVERLAY_CACHE.clear()


def fmt_num(value):
    """Tausenderzeichen passend zur Sprache (de: 1.000, en: 1,000)."""
    if LANG == "de":
        return f"{int(value):,}".replace(",", ".")
    return f"{int(value):,}"


# ----------------------------------------------------------------------------
# Audio-Helfer
# ----------------------------------------------------------------------------
def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, **kw)


def _edge_tts_bin():
    env = os.environ.get("EXPLAINER_EDGE_TTS")
    if env and os.path.exists(env):
        return env
    local = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         ".venv-tts", "bin", "edge-tts")
    if os.path.exists(local):
        return local
    return shutil.which("edge-tts")


def is_neural_voice(voice):
    return bool(re.match(r"^[a-z]{2}-[A-Z]{2}-.+Neural$", voice or ""))


def tts_scene(text, voice, rate, out_wav, edge_rate="+0%"):
    """Vertont einen Satz.

    Neuralstimmen (z. B. en-US-AriaNeural) laufen über edge-tts und klingen
    deutlich natürlicher. Alles andere geht offline über macOS `say`.
    Ergebnis ist immer eine 48-kHz-Mono-WAV.
    """
    if is_neural_voice(voice):
        edge = _edge_tts_bin()
        if not edge:
            raise RuntimeError(
                "edge-tts nicht gefunden. Installieren mit: "
                "python3.11 -m venv .venv-tts && .venv-tts/bin/pip install edge-tts"
            )
        tmp = tempfile.mktemp(suffix=".mp3")
        try:
            run([edge, "--voice", voice, "--text", text,
                 "--rate", edge_rate, "--write-media", tmp])
            run(["ffmpeg", "-y", "-i", tmp, "-ac", "1", "-ar", str(SR),
                 "-c:a", "pcm_s16le", out_wav])
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
    else:
        tmp = tempfile.mktemp(suffix=".aiff")
        try:
            run(["say", "-v", voice, "-r", str(rate), "-o", tmp, text])
            run(["ffmpeg", "-y", "-i", tmp, "-ac", "1", "-ar", str(SR),
                 "-c:a", "pcm_s16le", out_wav])
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
    with wave.open(out_wav, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def read_wav_mono(path):
    with wave.open(path, "rb") as w:
        n = w.getnframes()
        data = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    return data


def read_wav_stereo48(path):
    tmp = tempfile.mktemp(suffix=".wav")
    try:
        run(["ffmpeg", "-y", "-i", path, "-ac", "2", "-ar", str(SR), "-c:a", "pcm_s16le", tmp])
        with wave.open(tmp, "rb") as w:
            n = w.getnframes()
            a = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
        return a.reshape(-1, 2)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


# ----------------------------------------------------------------------------
# Karte
# ----------------------------------------------------------------------------
class WorldMap:
    def __init__(self):
        base = C.load_world_map().convert("RGB")
        # Kräftiger aufbereitet für Vollbild-Nutzung
        self.base = base.resize((3072, 3072), Image.LANCZOS)
        self.base = self.base.point(lambda v: int(v * 0.72))
        self.MW, self.MH = self.base.size

    def crop(self, cam):
        cx, cy, span = cam
        vw = max(480, int(self.MW * span))
        vh = int(vw * VH / VW)
        if vh > self.MH:
            vh = self.MH
            vw = int(vh * VW / VH)
        x = int(cx * self.MW - vw / 2)
        y = int(cy * self.MH - vh / 2)
        x = max(0, min(self.MW - vw, x))
        y = max(0, min(self.MH - vh, y))
        return self.base.crop((x, y, x + vw, y + vh)).resize((VW, VH), Image.LANCZOS)

    def to_screen(self, lat, lon, cam):
        """Geografische Koordinate -> Bildschirmkoordinate für die aktuelle Kamera."""
        cx, cy, span = cam
        vw = max(480, int(self.MW * span))
        vh = int(vw * VH / VW)
        if vh > self.MH:
            vh = self.MH
            vw = int(vh * VW / VH)
        x0 = max(0, min(self.MW - vw, int(cx * self.MW - vw / 2)))
        y0 = max(0, min(self.MH - vh, int(cy * self.MH - vh / 2)))
        mx = (lon + 180) / 360.0 * self.MW
        my = (1 - math.log(math.tan(math.pi / 4 + math.radians(max(-84.9, min(84.9, lat))) / 2)) / math.pi) / 2 * self.MH
        return (mx - x0) * VW / vw, (my - y0) * VH / vh


def lerp(a, b, u):
    return a + (b - a) * u


def cam_at(cams, u):
    if len(cams) == 1:
        return cams[0]
    u = max(0.0, min(1.0, u))
    pos = u * (len(cams) - 1)
    i = min(len(cams) - 2, int(pos))
    f = pos - i
    f = f * f * (3 - 2 * f)
    return tuple(lerp(cams[i][k], cams[i + 1][k], f) for k in range(3))


# ----------------------------------------------------------------------------
# Zeichnen
# ----------------------------------------------------------------------------
_OVERLAY_CACHE = {}


def _bottom_overlay():
    if "bottom" not in _OVERLAY_CACHE:
        height = 560
        ov = Image.new("RGBA", (VW, VH), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        for i in range(height):
            a = int(235 * (i / height) ** 1.5)
            d.line([(0, VH - height + i), (VW, VH - height + i)], fill=(4, 7, 14, a))
        _OVERLAY_CACHE["bottom"] = ov
    return _OVERLAY_CACHE["bottom"]


def _top_overlay():
    if "top" not in _OVERLAY_CACHE:
        height = 210
        ov = Image.new("RGBA", (VW, VH), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        for i in range(height):
            a = int(175 * (1 - i / height) ** 1.6)
            d.line([(0, i), (VW, i)], fill=(4, 7, 14, a))
        _OVERLAY_CACHE["top"] = ov
    return _OVERLAY_CACHE["top"]


def _header_overlay():
    if "header" not in _OVERLAY_CACHE:
        ov = Image.new("RGBA", (VW, VH), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        f = C.font(30, "bold")
        d.text((110, 54), "PIXELMAPS", font=f, fill=(255, 255, 255))
        w = d.textlength("PIXELMAPS", font=f)
        d.text((110 + w + 12, 54), ".ORG", font=C.font(30, "regular"), fill=CYAN)
        chip = TXT["header"]
        fc = C.font(24, "medium")
        tw = d.textlength(chip, font=fc)
        d.rounded_rectangle([VW - 110 - tw - 44, 44, VW - 110, 104], radius=30,
                            fill=(255, 255, 255, 14), outline=(120, 220, 255, 60))
        d.text((VW - 110 - tw - 22, 62), chip, font=fc, fill=(210, 232, 246))
        _OVERLAY_CACHE["header"] = ov
    return _OVERLAY_CACHE["header"]


def scene_overlay(idx, sc):
    """Statischer Text je Szene – einmal bauen, dann pro Frame nur einkleben."""
    key = ("scene", idx)
    if key in _OVERLAY_CACHE:
        return _OVERLAY_CACHE[key]
    ov = Image.new("RGBA", (VW, VH), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    if sc["visual"] != "brand":
        d.text((112, VH - 300), "PIXELMAPS.ORG", font=C.font(24, "demi"), fill=CYAN)
        head_size = 74 if sc["visual"] == "intro" else 62
        fh = C.font(head_size, "bold")
        fs = C.font(32, "medium")
        head = sc["head"].replace("{remaining}", fmt_num(STATS["remaining"]))
        d.text((110, VH - 240), head, font=fh, fill=(255, 255, 255))
        if sc["sub"]:
            d.text((110, VH - 240 + head_size + 22), sc["sub"], font=fs, fill=DIM)
    _OVERLAY_CACHE[key] = ov
    return ov


_DOT_CACHE = {}


def dot_sprite(color, r, glow=2.4, alpha=255):
    """Vorgefertigter Glow-Punkt (klein) – wird pro Frame nur noch eingeklebt.
    Vorher wurde pro Punkt eine 1920x1080-Ebene geblurrt: viel zu langsam."""
    key = (tuple(color), int(r), round(glow, 2), int(alpha))
    if key in _DOT_CACHE:
        return _DOT_CACHE[key]
    gr = int(r * glow)
    size = gr * 2 + 2
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse([1, 1, size - 2, size - 2], fill=tuple(color) + (int(alpha * 0.20),))
    layer = layer.filter(ImageFilter.GaussianBlur(max(1, gr * 0.45)))
    d2 = ImageDraw.Draw(layer)
    d2.ellipse([gr - r, gr - r, gr + r, gr + r], fill=tuple(color) + (alpha,))
    _DOT_CACHE[key] = layer
    return layer


def paste_dot(img, x, y, r, color, glow=2.4, alpha=255):
    sp = dot_sprite(color, r, glow, alpha)
    gr = int(r * glow)
    img.alpha_composite(sp, (int(x) - gr, int(y) - gr))


def ring(img, x, y, r, color, width=3, alpha=210):
    d = ImageDraw.Draw(img)
    d.ellipse([x - r, y - r, x + r, y + r], outline=tuple(color) + (alpha,), width=width)


def big_number(img, value, caption, y=None, size=190, color=(255, 255, 255)):
    """Große Zahl mittig, mit Tausenderpunkten."""
    s = fmt_num(value)
    d = ImageDraw.Draw(img)
    f = C.font(size, "bold")
    tw = d.textlength(s, font=f)
    y = y if y is not None else VH // 2 - size * 0.62
    d.text(((VW - tw) / 2, y + 4), s, font=f, fill=(0, 0, 0, 120))
    d.text(((VW - tw) / 2, y), s, font=f, fill=color)
    fc = C.font(34, "medium")
    cw = d.textlength(caption, font=fc)
    d.text(((VW - cw) / 2, y + size * 1.12), caption, font=fc, fill=DIM)
    return img


def certificate_card(img):
    w, h = 780, 420
    x, y = (VW - w) // 2, 150
    layer = Image.new("RGBA", (VW, VH), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle([x, y, x + w, y + h], radius=26, fill=(250, 250, 246, 246))
    d.rounded_rectangle([x + 18, y + 18, x + w - 18, y + h - 18], radius=18, outline=(18, 30, 44, 90), width=2)
    tag = TXT["cert_tag"]
    ft = C.font(20, "demi")
    tw = d.textlength(tag, font=ft)
    d.text((x + w - 52 - tw, y + 58), tag, font=ft, fill=(170, 120, 60))
    d.text((x + 52, y + 54), TXT["cert_title"], font=C.font(30, "demi"), fill=(90, 105, 120))
    d.text((x + 52, y + 104), TXT["cert_owner"], font=C.font(34, "regular"), fill=(30, 40, 52))
    d.text((x + 52, y + 158), TXT["cert_name"], font=C.font(62, "bold"), fill=(8, 14, 24))
    d.text((x + 52, y + 246), TXT["cert_number"], font=C.font(30, "medium"), fill=(40, 52, 66))
    d.text((x + 52, y + 292), TXT["cert_coords"], font=C.font(26, "regular"), fill=(90, 105, 120))
    d.text((x + 52, y + 344), "pixelmaps.org", font=C.font(26, "demi"), fill=(14, 120, 140))
    return Image.alpha_composite(img.convert("RGBA"), layer)


def brand_lockup(img, t):
    d = ImageDraw.Draw(img)
    f = C.font(120, "bold")
    s = "PIXELMAPS"
    tw = d.textlength(s, font=f)
    d.text(((VW - tw) / 2, VH // 2 - 190), s, font=f, fill=(255, 255, 255))
    f2 = C.font(44, "medium")
    url = "pixelmaps.org"
    tw2 = d.textlength(url, font=f2)
    d.text(((VW - tw2) / 2, VH // 2 - 40), url, font=f2, fill=CYAN)
    f3 = C.font(34, "regular")
    cta = TXT["brand_cta"]
    tw3 = d.textlength(cta, font=f3)
    d.text(((VW - tw3) / 2, VH // 2 + 40), cta, font=f3, fill=DIM)
    return img


# ----------------------------------------------------------------------------
# Render
# ----------------------------------------------------------------------------
def fetch_stats():
    try:
        import urllib.request
        with urllib.request.urlopen(f"https://{SITE}/api/stats", timeout=6) as r:
            d = json.loads(r.read().decode())
        return {
            "total": int(d.get("total", 1_000_000_000)),
            "sold": int(d.get("sold", 0)),
            "remaining": int(d.get("remaining", 1_000_000_000)),
        }
    except Exception:
        return {"total": 1_000_000_000, "sold": 0, "remaining": 1_000_000_000}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--lang", choices=["de", "en"], default="de")
    ap.add_argument("--voice", default=None, help="Standard: Anna (de) / en-US-AriaNeural (en)")
    ap.add_argument("--rate", type=int, default=168, help="macOS-say: Wörter/min")
    ap.add_argument("--edge-rate", default="+0%", help="edge-tts-Geschwindigkeit, z. B. +5%% oder -5%%")
    ap.add_argument("--test", action="store_true", help="nur die ersten zwei Szenen rendern")
    ap.add_argument("--no-music", action="store_true")
    ap.add_argument("--srt", action="store_true", help="Untertitel-Datei (.srt) zur Vertonung schreiben")
    ap.add_argument("--keep-frames", action="store_true", help="Temp-Ordner mit WAVs behalten")
    args = ap.parse_args()

    set_lang(args.lang)
    if not args.voice:
        args.voice = os.environ.get("EXPLAINER_VOICE") or TXT["default_voice"]

    global STATS
    STATS = fetch_stats()
    stats = STATS
    scenes = SCENES[args.lang][:2] if args.test else SCENES[args.lang]
    print(f"PixelMaps-Erklärvideo [{args.lang}]: {len(scenes)} Szenen | "
          f"Stimme={args.voice} | sold={stats['sold']} frei={stats['remaining']}")

    tmp = tempfile.mkdtemp(prefix="pixelmaps_yt_")
    try:
        # 1) Vertonung pro Szene
        timeline = []
        t = 0.0
        for i, sc in enumerate(scenes):
            wav = os.path.join(tmp, f"n{i:02d}.wav")
            dur = tts_scene(sc["voice"], args.voice, args.rate, wav, args.edge_rate)
            total = sc["lead"] + dur + sc["tail"]
            timeline.append(dict(idx=i, scene=sc, start=t, end=t + total, narr=wav, narr_dur=dur))
            t += total
            print(f"  Szene {i + 1}/{len(scenes)}: {sc['id']:<12} {total:5.2f}s (Sprache {dur:4.2f}s)")
        duration = t
        print(f"Gesamtlänge: {duration:.2f}s")

        if args.srt:
            def ts(sec):
                ms = int(round(sec * 1000))
                h, ms = divmod(ms, 3600000)
                m, ms = divmod(ms, 60000)
                sec2, ms = divmod(ms, 1000)
                return f"{h:02d}:{m:02d}:{sec2:02d},{ms:03d}"
            srt_path = os.path.splitext(args.out)[0] + ".srt"
            lines = []
            for n, item in enumerate(timeline, 1):
                a = item["start"] + item["scene"]["lead"]
                b = a + item["narr_dur"] + 0.25
                lines += [str(n), f"{ts(a)} --> {ts(b)}", item["scene"]["voice"], ""]
            with open(srt_path, "w", encoding="utf-8") as f:
                f.write("\n".join(lines))
            print(f"Untertitel: {srt_path}")

        # 2) Karte + Kamera-Keyframes
        wm = WorldMap()
        keys = []
        for item in timeline:
            sc = item["scene"]
            n = len(sc["cam"])
            for k, cam in enumerate(sc["cam"]):
                tt = item["start"] + (item["end"] - item["start"]) * (k / max(1, n - 1))
                if n == 1:
                    tt = (item["start"] + item["end"]) / 2
                keys.append((tt, cam))

        def cam_frame(tt):
            if tt <= keys[0][0]:
                return keys[0][1]
            for i in range(len(keys) - 1):
                t0, c0 = keys[i]
                t1, c1 = keys[i + 1]
                if t0 <= tt <= t1:
                    u = 0 if t1 == t0 else (tt - t0) / (t1 - t0)
                    u = u * u * (3 - 2 * u)
                    return tuple(lerp(c0[j], c1[j], u) for j in range(3))
            return keys[-1][1]

        # Landmarks für die Karte
        landmarks = [(n, la, lo) for (n, la, lo) in C.LANDMARKS][:34]

        # 3) Frames direkt in ffmpeg pipen (kein PNG-Zwischenspeicher)
        silent = os.path.join(tmp, "silent.mp4")
        ff = subprocess.Popen(
            ["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{VW}x{VH}",
             "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "19",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", silent],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

        frames = int(round(duration * FPS))
        for fi in range(frames):
            tt = fi / FPS
            item = timeline[-1]
            for it in timeline:
                if it["start"] <= tt < it["end"]:
                    item = it
                    break
            sc = item["scene"]
            u = (tt - item["start"]) / max(1e-6, item["end"] - item["start"])
            cam = cam_frame(tt)

            img = wm.crop(cam).convert("RGBA")
            img.alpha_composite(_top_overlay())
            img.alpha_composite(_bottom_overlay())
            img.alpha_composite(_header_overlay())

            # Pixel-Punkte: poppen nacheinander auf (nur Deko, keine Verkaufszahlen)
            if sc["visual"] in ("intro", "dots", "highlight", "pick", "race", "free", "price"):
                appear = 0.55 + u * 0.45 if sc["visual"] == "dots" else 0.9
                for i, (name, la, lo) in enumerate(landmarks):
                    if i / max(1, len(landmarks)) > appear:
                        break
                    x, y = wm.to_screen(la, lo, cam)
                    if -60 < x < VW + 60 and -60 < y < VH + 60:
                        hue = C.PIXEL_HUES[i % len(C.PIXEL_HUES)]
                        rgb = C.hsl_to_rgb(hue, 0.92, 0.62)
                        paste_dot(img, x, y, 6, rgb, 2.6, 220)

            if sc["visual"] == "intro":
                f = C.font(56, "medium")
                d = ImageDraw.Draw(img)
                tw = d.textlength(TXT["intro_line"], font=f)
                d.text(((VW - tw) / 2, 300), TXT["intro_line"], font=f, fill=(226, 240, 250))

            elif sc["visual"] == "highlight":
                x, y = wm.to_screen(52.52, 13.40, cam)   # Berlin
                pulse = 1 + 0.12 * math.sin(tt * 6)
                ring(img, x, y, int(46 * pulse), MINT, 3, 220)
                ring(img, x, y, int(92 * pulse), MINT, 2, 90)
                paste_dot(img, x, y, 9, MINT, 3.0, 255)
                d = ImageDraw.Draw(img)
                d.text((x + 24, y - 74), TXT["point"], font=C.font(30, "demi"), fill=(215, 255, 245))

            elif sc["visual"] == "pick":
                x, y = wm.to_screen(52.52, 13.40, cam)
                paste_dot(img, x, y, 8, MINT, 3.0, 255)
                ring(img, x, y, 34 + int(22 * u), MINT, 2, int(150 * (1 - u)) + 60)
                d = ImageDraw.Draw(img)
                d.text((x + 20, y + 22), "52.5200° N · 13.4050° E", font=C.font(28, "medium"), fill=(200, 240, 250))

            elif sc["visual"] == "price":
                img = big_number(img, 1, TXT["price_caption"], y=300, size=240)

            elif sc["visual"] == "certificate":
                img = certificate_card(img)

            elif sc["visual"] == "race":
                d = ImageDraw.Draw(img)
                f = C.font(34, "medium")
                items = TXT["race"]
                x0 = 110
                for i, name in enumerate(items):
                    tw = d.textlength(name, font=f)
                    y = 190 + i * 62
                    d.rounded_rectangle([x0, y, x0 + tw + 44, y + 48], radius=24,
                                        fill=(8, 14, 26, 190), outline=(120, 220, 255, 70))
                    d.text((x0 + 22, y + 8), name, font=f, fill=(226, 240, 250))

            elif sc["visual"] == "free":
                img = big_number(img, stats["remaining"], TXT["free_caption"], y=320, size=150)
                d = ImageDraw.Draw(img)
                sub = f"{TXT['sold']}: {fmt_num(stats['sold'])}"
                tw = d.textlength(sub, font=C.font(34, "medium"))
                d.text(((VW - tw) / 2, 700), sub, font=C.font(34, "medium"), fill=DIM)

            elif sc["visual"] == "brand":
                img = brand_lockup(img, tt)

            img.alpha_composite(scene_overlay(item["idx"], sc))

            ff.stdin.write(img.convert("RGB").tobytes())
            if fi % 150 == 0:
                print(f"  Frame {fi}/{frames} ({100 * fi / frames:.0f} %)")

        ff.stdin.close()
        ff.wait()
        if ff.returncode != 0:
            raise RuntimeError("ffmpeg (Video) fehlgeschlagen")

        # 4) Tonspur: Sprache + Musik
        n_total = int(duration * SR) + SR
        mix = np.zeros((n_total, 2), dtype=np.float32)
        for item in timeline:
            a = read_wav_mono(item["narr"])
            start = int((item["start"] + item["scene"]["lead"]) * SR)
            end = min(n_total, start + len(a))
            # sanfte Blende, damit Sprachsätze nicht knallen
            fade = min(int(0.012 * SR), max(1, len(a) // 12))
            env = np.ones(len(a), dtype=np.float32)
            env[:fade] = np.linspace(0, 1, fade)
            env[-fade:] = np.linspace(1, 0, fade)
            a = a * env
            mix[start:end, 0] += a[: end - start]
            mix[start:end, 1] += a[: end - start]

        if not args.no_music:
            mus_path = C.synth_music(duration + 1.0, "uplift")
            mus = read_wav_stereo48(mus_path)
            if len(mus) < n_total:
                mus = np.pad(mus, ((0, n_total - len(mus)), (0, 0)))
            mus = mus[:n_total] * 0.17
            fade = int(2.0 * SR)
            mus[:fade] *= np.linspace(0, 1, fade)[:, None]
            mus[-fade:] *= np.linspace(1, 0, fade)[:, None]
            mix += mus

        peak = float(np.max(np.abs(mix))) or 1.0
        mix = mix / peak * 0.89
        mix[-int(0.6 * SR):] *= np.linspace(1, 0, int(0.6 * SR))[:, None]

        audio_wav = os.path.join(tmp, "audio.wav")
        with wave.open(audio_wav, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((mix * 32767).astype(np.int16).tobytes())

        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        run(["ffmpeg", "-y", "-i", silent, "-i", audio_wav,
             "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
             "-shortest", "-movflags", "+faststart", args.out])
        size = os.path.getsize(args.out) / 1e6
        print(f"OK: {args.out}  ({duration:.1f}s, {size:.1f} MB)")
    finally:
        if args.keep_frames:
            print(f"Temp-Ordner behalten: {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
