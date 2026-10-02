#!/usr/bin/env python3
"""
clipmap.py – animierte PixelMaps-Weltkarte als vertikaler Kurzclip.
Kein KI-Bild, keine Stimme: echte Weltkarte (gecachte OSM-Tiles im Night-Modus
der Seite), auf der nacheinander Pixel aufploppen (West -> Ost), mit
prozeduraler Ambient-Musik statt Sprachausgabe.

Nutzung:
  python3 clipmap.py --prompt "HOOK" --title "TITEL" \
    --out public/clips/generated/2026-09-21-TikTok.mp4 [--duration 6]
"""
import argparse, json, math, os, random, subprocess, sys, tempfile, shutil
import numpy as np
from PIL import Image, ImageDraw

W = 1080
H = 1920
FPS = 30
SR = 44100

ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
BASE_TILES = os.path.join(ASSETS, "tiles")
NAVY = (5, 9, 17)
NAVY2 = (8, 14, 28)
PIXEL_HUES = [15, 45, 75, 105, 135, 165, 195, 225, 255, 285, 315, 345]

# 5 Beispieldesigns mit eigener Optik, Musik und Text
VARIANT = {
    "classic": {
        "name": "Classic Navy",
        "bg": (5, 9, 17), "bg2": (8, 14, 28), "light": False,
        "map": {"saturation": 1.0, "brightness": 1.0, "contrast": 1.0},
        "px": {"sat": 0.92, "light": 0.58, "glow": 1.0, "rad": 8},
        "fx": [],
        "eyebrow": "WELTREKORD-VERSUCH",
        "claim": [
            ("Was wäre, wenn", "regular", 46, "white"),
            ("eine Milliarde Pixel", "bold", 64, "gradient"),
            ("eine gemeinsame Weltkarte", "regular", 40, "white"),
            ("bilden würden?", "demi", 56, "soft"),
        ],
        "caption": "40.000 × 25.000 Kacheln  ·  1 € je Pixel",
        "music": {"chords": "classic", "pluck": "classic"},
    },
    "neon": {
        "name": "Neon Grid",
        "bg": (4, 6, 16), "bg2": (10, 8, 26), "light": False,
        "map": {"saturation": 0.95, "brightness": 0.42, "contrast": 1.35},
        "px": {"sat": 0.95, "light": 0.62, "glow": 2.0, "rad": 10},
        "fx": ["grid", "scan"],
        "eyebrow": "DEIN PIXEL · DEINE GESCHICHTE",
        "claim": [
            ("DEIN PIXEL,", "bold", 64, "gradient"),
            ("DEINE GESCHICHTE", "regular", 42, "white"),
            ("AUF DER WELTKARTE", "demi", 56, "soft"),
        ],
        "caption": "1 Milliarde Pixel · 1 € je Pixel",
        "music": {"chords": "drive", "pluck": "fast"},
    },
    "paper": {
        "name": "Paper Minimal",
        "bg": (245, 241, 231), "bg2": (238, 231, 218), "light": True,
        "map": {"saturation": 0.35, "brightness": 0.98, "contrast": 1.05},
        "px": {"sat": 0.55, "light": 0.42, "glow": 0.6, "rad": 6},
        "fx": ["border"],
        "eyebrow": "PIXELMAPS.ORG",
        "claim": [
            ("Jeder Punkt", "regular", 46, "dark"),
            ("hat eine Geschichte.", "bold", 62, "gradient"),
            ("Erzähle deine auf", "regular", 40, "dark"),
            ("der Weltkarte.", "demi", 54, "softdark"),
        ],
        "caption": "1 Pixel · 1 € · 1 Milliarde Punkte",
        "music": {"chords": "warm", "pluck": "soft"},
    },
    "pop": {
        "name": "Color Pop",
        "bg": (20, 8, 34), "bg2": (40, 12, 52), "light": False,
        "map": {"saturation": 1.25, "brightness": 0.55, "contrast": 1.25},
        "px": {"sat": 1.0, "light": 0.62, "glow": 3.5, "rad": 14},
        "fx": ["sparkle"],
        "eyebrow": "DIE FARBIGSTE WELTKARTE DER WELT",
        "claim": [
            ("1 Milliarde Pixel,", "bold", 64, "gradient"),
            ("ein Planet,", "regular", 42, "white"),
            ("dein Stück für immer.", "demi", 56, "soft"),
        ],
        "caption": "40.000 × 25.000 Kacheln · bunt & dauerhaft",
        "music": {"chords": "major", "pluck": "fresh"},
    },
    "cinema": {
        "name": "Cinematic",
        "bg": (2, 3, 8), "bg2": (6, 7, 14), "light": False,
        "map": {"saturation": 0.55, "brightness": 0.38, "contrast": 1.5},
        "px": {"sat": 0.75, "light": 0.58, "glow": 1.6, "rad": 10},
        "fx": ["vignette"],
        "eyebrow": "EINE MILLIARDE MENSCHEN · EINE KARTE",
        "claim": [
            ("One billion people.", "bold", 58, "gradient"),
            ("One world map.", "regular", 42, "white"),
            ("One pixel – yours.", "demi", 54, "soft"),
        ],
        "caption": "pixelmaps.org · dein Punkt wartet auf dich",
        "music": {"chords": "epic", "pluck": "none"},
    },
}
# Uebersetzte Texte fuer die Varianten neon/pop (Sprachrotation pro Tag)
VARIANT_TEXT = {
    "neon": {
        "de": {"eyebrow": "DEIN PIXEL · DEINE GESCHICHTE",
               "claim": [("DEIN PIXEL,", "bold", 64, "gradient"), ("DEINE GESCHICHTE", "regular", 42, "white"), ("AUF DER WELTKARTE", "demi", 56, "soft")],
               "caption": "1 Milliarde Pixel · 1 € je Pixel"},
        "en": {"eyebrow": "YOUR PIXEL · YOUR STORY",
               "claim": [("YOUR PIXEL,", "bold", 64, "gradient"), ("YOUR STORY", "regular", 42, "white"), ("ON THE WORLD MAP", "demi", 56, "soft")],
               "caption": "1 billion pixels · €1 per pixel"},
        "es": {"eyebrow": "TU PÍXEL · TU HISTORIA",
               "claim": [("TU PÍXEL,", "bold", 64, "gradient"), ("TU HISTORIA", "regular", 42, "white"), ("EN EL MAPA DEL MUNDO", "demi", 56, "soft")],
               "caption": "1000 millones de píxeles · 1 €/píxel"},
        "fr": {"eyebrow": "TON PIXEL · TON HISTOIRE",
               "claim": [("TON PIXEL,", "bold", 64, "gradient"), ("TON HISTOIRE", "regular", 42, "white"), ("SUR LE PLANISPHÈRE", "demi", 56, "soft")],
               "caption": "Un milliard de pixels · 1 € le pixel"},
        "it": {"eyebrow": "IL TUO PIXEL · LA TUA STORIA",
               "claim": [("IL TUO PIXEL,", "bold", 64, "gradient"), ("LA TUA STORIA", "regular", 42, "white"), ("SULLA MAPPA DEL MONDO", "demi", 56, "soft")],
               "caption": "Un miliardo di pixel · 1 € a pixel"},
        "pt": {"eyebrow": "TEU PÍXEL · A TUA HISTÓRIA",
               "claim": [("TEU PÍXEL,", "bold", 64, "gradient"), ("A TUA HISTÓRIA", "regular", 42, "white"), ("NO MAPA DO MUNDO", "demi", 56, "soft")],
               "caption": "Mil milhões de pixels · 1 € por pixel"},
        "tr": {"eyebrow": "SENİN PİKSELİN · SENİN HİKÂYEN",
               "claim": [("SENİN PİKSELİN,", "bold", 64, "gradient"), ("SENİN HİKÂYEN", "regular", 42, "white"), ("DÜNYA HARİTASINDA", "demi", 56, "soft")],
               "caption": "Bir milyar piksel · piksel başına 1 €"},
    },
    "pop": {
        "de": {"eyebrow": "DIE FARBIGSTE WELTKARTE DER WELT",
               "claim": [("1 Milliarde Pixel,", "bold", 64, "gradient"), ("ein Planet,", "regular", 42, "white"), ("dein Stück für immer.", "demi", 56, "soft")],
               "caption": "40.000 × 25.000 Kacheln · bunt & dauerhaft"},
        "en": {"eyebrow": "THE MOST COLOURFUL WORLD MAP IN THE WORLD",
               "claim": [("A billion pixels,", "bold", 64, "gradient"), ("one planet,", "regular", 42, "white"), ("your piece, forever.", "demi", 56, "soft")],
               "caption": "40,000 × 25,000 tiles · colourful & forever"},
        "es": {"eyebrow": "EL MAPA DEL MUNDO MÁS COLORIDO",
               "claim": [("Mil millones de píxeles,", "bold", 64, "gradient"), ("un planeta,", "regular", 42, "white"), ("tu pedacito para siempre.", "demi", 56, "soft")],
               "caption": "40 000 × 25 000 mosaicos · colorido & para siempre"},
        "fr": {"eyebrow": "LE PLANISPHÈRE LE PLUS COLORÉ DU MONDE",
               "claim": [("Un milliard de pixels,", "bold", 64, "gradient"), ("une planète,", "regular", 42, "white"), ("ton coin pour toujours.", "demi", 56, "soft")],
               "caption": "40 000 × 25 000 tuiles · coloré & pour toujours"},
        "it": {"eyebrow": "LA MAPPA DEL MONDO PIÙ COLORATA",
               "claim": [("Un miliardo di pixel,", "bold", 64, "gradient"), ("un pianeta,", "regular", 42, "white"), ("il tuo pezzetto per sempre.", "demi", 56, "soft")],
               "caption": "40 000 × 25 000 tessere · colorato & per sempre"},
        "pt": {"eyebrow": "O MAPA DO MUNDO MAIS COLORIDO",
               "claim": [("Mil milhões de pixels,", "bold", 64, "gradient"), ("um planeta,", "regular", 42, "white"), ("o teu pedacinho para sempre.", "demi", 56, "soft")],
               "caption": "40 000 × 25 000 mosaicos · colorido & para sempre"},
        "tr": {"eyebrow": "DÜNYANIN EN RENKLİ HARİTASI",
               "claim": [("Bir milyar piksel,", "bold", 64, "gradient"), ("bir gezegen,", "regular", 42, "white"), ("senin parçan, sonsuza dek.", "demi", 56, "soft")],
               "caption": "40.000 × 25.000 karo · renkli & kalıcı"},
    },
}


FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Avenir Next.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]

CLAIM_LINES = [
    ("Was wäre, wenn", "regular", 46, "white"),
    ("eine Milliarde Pixel", "bold", 64, "gradient"),
    ("eine gemeinsame Weltkarte", "regular", 40, "white"),
    ("bilden würden?", "demi", 56, "soft"),
]

# 7 Sprachen fuer den Weltrekord-Versuch (eine pro Tag)
LANG = {
    "de": {
        "eyebrow": "WELTREKORD-VERSUCH",
        "claim": [
            ("Was wäre, wenn", "regular", 46, "white"),
            ("eine Milliarde Pixel", "bold", 64, "gradient"),
            ("eine gemeinsame Weltkarte", "regular", 40, "white"),
            ("bilden würden?", "demi", 56, "soft"),
        ],
        "caption": "40.000 \u00d7 25.000 Kacheln  \u00b7  1 \u20ac je Pixel",
    },
    "en": {
        "eyebrow": "WORLD RECORD ATTEMPT",
        "claim": [
            ("What if", "regular", 46, "white"),
            ("a billion pixels", "bold", 64, "gradient"),
            ("made one shared", "regular", 40, "white"),
            ("world map?", "demi", 56, "soft"),
        ],
        "caption": "40,000 \u00d7 25,000 tiles  \u00b7  \u20ac1 per pixel",
    },
    "es": {
        "eyebrow": "INTENTO DE \u00c9R\u00c9CORD MUNDIAL",
        "claim": [
            ("\u00bfQu\u00e9 pasar\u00eda si", "regular", 46, "white"),
            ("mil millones de", "bold", 64, "gradient"),
            ("p\u00edxeles formaran", "regular", 40, "white"),
            ("un \u00fanico mapa?", "demi", 56, "soft"),
        ],
        "caption": "40 000 \u00d7 25 000 mosaicos  \u00b7  1 \u20ac/p\u00edxel",
    },
    "fr": {
        "eyebrow": "TENTATIVE DE RECORD DU MONDE",
        "claim": [
            ("Et si", "regular", 46, "white"),
            ("un milliard", "bold", 64, "gradient"),
            ("de pixels dessinaient", "regular", 40, "white"),
            ("un m\u00eame planisph\u00e8re?", "demi", 56, "soft"),
        ],
        "caption": "40 000 \u00d7 25 000 tuiles  \u00b7  1 \u20ac le pixel",
    },
    "it": {
        "eyebrow": "TENTATIVO DI RECORD MONDIALE",
        "claim": [
            ("E se", "regular", 46, "white"),
            ("un miliardo di pixel", "bold", 64, "gradient"),
            ("disegnasse una mappa", "regular", 40, "white"),
            ("del mondo condivisa?", "demi", 56, "soft"),
        ],
        "caption": "40 000 \u00d7 25 000 tessere  \u00b7  1 \u20ac a pixel",
    },
    "pt": {
        "eyebrow": "TENTATIVA DE RECORDE MUNDIAL",
        "claim": [
            ("E se", "regular", 46, "white"),
            ("mil milh\u00f5es de pixels", "bold", 64, "gradient"),
            ("desenhassem um mapa", "regular", 40, "white"),
            ("do mundo comum?", "demi", 56, "soft"),
        ],
        "caption": "40 000 \u00d7 25 000 mosaicos  \u00b7  1 \u20ac por pixel",
    },
    "tr": {
        "eyebrow": "D\u00dcNYA REKORU DENEMES\u0130",
        "claim": [
            ("Ya", "regular", 46, "white"),
            ("bir milyar piksel", "bold", 64, "gradient"),
            ("hep birlikte tek bir", "regular", 40, "white"),
            ("d\u00fcnya haritas\u0131 olsa?", "demi", 56, "soft"),
        ],
        "caption": "40.000 \u00d7 25.000 karo  \u00b7  piksel ba\u015f\u0131na 1 \u20ac",
    },
}

LANDMARKS = [
    ("Vancouver", 49.3, -123.1), ("Los Angeles", 34.0, -118.2), ("Mexico City", 19.4, -99.1),
    ("Denver", 39.7, -104.9), ("New York", 40.7, -74.0), ("Bogota", 4.6, -74.1),
    ("Lima", -12.0, -77.0), ("Brasilia", -15.8, -47.9), ("Rio de Janeiro", -22.9, -43.2),
    ("Santiago", -33.4, -70.7), ("Buenos Aires", -34.6, -58.4), ("Reykjavik", 64.1, -21.9),
    ("Lisbon", 38.7, -9.1), ("Madrid", 40.4, -3.7), ("London", 51.5, -0.1),
    ("Paris", 48.9, 2.35), ("Amsterdam", 52.4, 4.9), ("Berlin", 52.5, 13.4),
    ("Prague", 50.1, 14.4), ("Vienna", 48.2, 16.4), ("Rome", 41.9, 12.5),
    ("Warsaw", 52.2, 21.0), ("Stockholm", 59.3, 18.1), ("Athens", 38.0, 23.7),
    ("Istanbul", 41.0, 28.9), ("Kyiv", 50.45, 30.5), ("Cairo", 30.0, 31.2),
    ("Nairobi", -1.3, 36.8), ("Cape Town", -33.9, 18.4), ("Lagos", 6.5, 3.4),
    ("Dubai", 25.2, 55.3), ("Tehran", 35.7, 51.4), ("Riyadh", 24.7, 46.7),
    ("Mumbai", 19.1, 72.9), ("New Delhi", 28.6, 77.2), ("Kathmandu", 27.7, 85.3),
    ("Bangkok", 13.8, 100.5), ("Singapore", 1.35, 103.8), ("Hong Kong", 22.3, 114.2),
    ("Hanoi", 21.0, 105.8), ("Shanghai", 31.2, 121.5), ("Beijing", 39.9, 116.4),
    ("Seoul", 37.6, 127.0), ("Tokyo", 35.7, 139.7), ("Sydney", -33.9, 151.2),
    ("Auckland", -36.8, 174.8),
]


def hue(name_or_id):
    if isinstance(name_or_id, int):
        return PIXEL_HUES[(abs(name_or_id) * 5) % 12]
    h = 0
    for c in name_or_id:
        h = (h * 31 + ord(c)) & 0xffffffff
    return PIXEL_HUES[h % 12]


def hsl_to_rgb(h, s, l):
    h = (h % 360) / 360.0
    m2 = l * (s + 1) if l <= 0.5 else l + s - l * s
    m1 = 2 * l - m2
    def f(n):
        n = (n + 1 / 3.0 if n < 0 else (n - 1 / 3.0 if n > 1 / 3.0 else 0)) if n < 0 else n
        if n < 1/6.0: return m1 + (m2 - m1) * n * 6
        if n < 0.5: return m2
        if n < 2/3.0: return m1 + (m2 - m1) * (2/3.0 - n) * 6
        return m1
    r_, g_, b_ = (f((h + 1 / 3.0) % 1.0), f(h), f((h - 1 / 3.0) % 1.0))
    return (int(r_ * 255), int(g_ * 255), int(b_ * 255))


def font(size, style="regular"):
    from PIL import ImageFont
    avenir = "/System/Library/Fonts/Supplemental/Avenir Next.ttc"
    idx = {"regular": 7, "medium": 5, "demi": 2, "bold": 0}.get(style, 7)
    if os.path.exists(avenir):
        return ImageFont.truetype(avenir, size, index=idx)
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_tracked(d, text, font, cx, y, fill, tracking=7):
    total = sum(d.textlength(ch, font=font) + tracking for ch in text) - tracking
    x = cx - total / 2
    for ch in text:
        d.text((x, y), ch, font=font, fill=fill)
        x += d.textlength(ch, font=font) + tracking


def draw_gradient(ov, d, text, font, cx, y, c_top, c_bot):
    total = d.textlength(text, font=font)
    x0 = cx - total / 2
    bbox = d.textbbox((0, 0), text, font=font)
    w = max(1, int(bbox[2] - bbox[0]))
    hf = max(1, int(bbox[3] - bbox[1]))
    mask = Image.new("L", (w, hf), 0)
    mdd = ImageDraw.Draw(mask)
    mdd.text((-bbox[0], -bbox[1]), text, font=font, fill=255)
    grad = Image.new("RGBA", (w, hf))
    gp = grad.load(); mp = mask.load()
    for yy in range(hf):
        t = yy / max(hf - 1, 1)
        col = tuple(int(c_top[i] + (c_bot[i] - c_top[i]) * t) for i in range(3))
        for xx in range(w):
            gp[xx, yy] = col + (mp[xx, yy],)
    ov.alpha_composite(grad, (int(x0) + bbox[0], int(y) + bbox[1]))


def load_world_map():
    cached = os.path.join(ASSETS, "world_navy.png")
    if os.path.exists(cached):
        return Image.open(cached).convert("RGB")
    big = Image.new("RGB", (2048, 2048))
    import urllib.request
    for x in range(8):
        for y in range(8):
            p = os.path.join(BASE_TILES, f"z3_{x}_{y}.png")
            if not os.path.exists(p):
                url = f"https://{'abc'[(x + y) % 3]}.tile.openstreetmap.org/3/{x}/{y}.png"
                req = urllib.request.Request(url, headers={"User-Agent": "pixelmaps-clipbuilder/1.0"})
                with urllib.request.urlopen(req, timeout=60) as r, open(p, "wb") as f:
                    f.write(r.read())
            big.paste(Image.open(p).convert("RGB"), (x * 256, y * 256))
    from PIL import ImageEnhance
    big = ImageEnhance.Color(big).enhance(0.72)
    big = ImageEnhance.Brightness(big).enhance(0.52)
    big = ImageEnhance.Contrast(big).enhance(1.2)
    big = big.crop((224, 224, 1824, 1824))
    os.makedirs(ASSETS, exist_ok=True)
    big.save(cached)
    return big


def mercator_y(lat):
    lat = max(-84.9, min(84.9, lat))
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def smoothstep(t):
    return t * t * (3 - 2 * t)


def ll_from_latlon(lat, lon, size=None, ins=None):
    size = size or W
    ins = ins or 26
    x = ins + (lon + 180) / 360.0 * (size - 2 * ins)
    yn = (1 - math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) / math.pi) / 2
    y = ins + yn * (size - 2 * ins)
    return x, y


def load_pixels():
    real = []
    path = os.path.join(ASSETS, "sold_pixels.json")
    if os.path.exists(path):
        try:
            real = json.load(open(path))
        except Exception:
            real = []
    pops = []
    for lm in LANDMARKS:
        name, la, lo = lm
        pop = {"lat": la, "lon": lo, "name": name, "real": False}
        pops.append(pop)
    for p in real:
        pop = {"lat": p.get("lat", 0), "lon": p.get("lon", 0),
               "name": p.get("display_name") or "", "real": True}
        pops.append(pop)
    pops.sort(key=lambda p: p["lon"])
    rnd = random.Random(20260921)
    seq = []
    t = 0.45
    for p in pops:
        p["t"] = t
        p["dt"] = rnd.uniform(0.09, 0.16)
        t += p["dt"]
        seq.append(p)
    return seq


def build_overlay(title, lang="de", variant="classic", custom=None):
    V = VARIANT.get(variant, VARIANT["classic"])
    if custom is not None:
        T = {
            "eyebrow": custom.get("eyebrow", ""),
            "claim": custom.get("claim", CLAIM_LINES),
            "caption": custom.get("caption", V.get("caption", "")),
        }
    elif variant == "classic":
        T = LANG.get(lang, LANG["de"])
    else:
        vt = VARIANT_TEXT.get(variant)
        if not vt:
            T = V
        else:
            T = vt.get(lang, vt["de"])
    light = V["light"]
    fill_white = (30, 42, 60) if light else (255, 255, 255, 255)
    fill_soft = (70, 105, 135, 255) if light else (166, 240, 255, 255)
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    # Kopf-Badge
    f_badge = font(38, "medium")
    badge_txt = "PIXELMAPS.ORG"
    bw = d.textlength(badge_txt, font=f_badge) + 56
    if light:
        d.rounded_rectangle([36, 36, 36 + bw, 112], radius=38,
                            fill=(255, 253, 246, 215), outline=(30, 42, 60, 200), width=2)
    else:
        d.rounded_rectangle([36, 36, 36 + bw, 112], radius=38,
                            fill=(8, 20, 38, 205), outline=(120, 220, 255, 220), width=2)
    d.text((68, 50), badge_txt, font=f_badge, fill=(150, 230, 255, 255) if not light else (30, 42, 60, 255))
    # unterer Verlauf fuer Textkontrast
    foot_top = (250, 247, 240) if light else (5, 9, 17)
    for i in range(H - 700, H):
        a = int(240 * (i - (H - 700)) / 700)
        d.rectangle([0, i, W, i], fill=foot_top + (a,))
    # Eyebrow
    f_ey = font(26, "medium")
    draw_tracked(d, T["eyebrow"].replace("   ", " \u00b7 "),
                 f_ey, W / 2, 1302, (60, 110, 140, 255) if light else (86, 225, 236, 255), tracking=6)
    # Claim-Zeilen
    y = 1370
    line_h = {46: 62, 64: 86, 40: 54, 42: 56, 54: 72, 56: 74, 58: 78, 62: 84}
    for text, style, size, kind in T["claim"]:
        f = font(size, style)
        tx = d.textlength(text, font=f) / 2
        if kind == "gradient":
            glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            gd = ImageDraw.Draw(glow)
            gd.text((W / 2 - tx, y + 3), text, font=f, fill=(0, 210, 220, 90))
            ov.alpha_composite(glow)
            gt = (40, 130, 150) if light else (120, 245, 255, 255)
            draw_gradient(ov, d, text, f, W / 2, y, gt, (255, 255, 255, 255) if not light else (30, 42, 60, 255))
        else:
            fill = fill_soft if kind == "soft" else (fill_white if kind in ("white", "dark") else (70, 105, 135, 255))
            if kind == "softdark" or kind == "dark":
                fill = (50, 66, 84, 255)
            d.text((W / 2 - tx, y), text, font=f, fill=fill)
        y += line_h.get(size, size + 20)
    # CTA
    f_cta = font(50, "demi")
    cta = "pixelmaps.org"
    cw = d.textlength(cta, font=f_cta) + 64
    by = 1658
    cta_fill = (0, 180, 210, 240) if not light else (214, 83, 74, 240)
    d.rounded_rectangle([(W - cw) / 2, by, (W + cw) / 2, by + 88], radius=44, fill=cta_fill)
    d.text(((W - d.textlength(cta, font=f_cta)) / 2, by + 12), cta, font=f_cta,
           fill=(255, 253, 246, 255) if not light else (255, 255, 255, 255))
    # Caption
    f_cap = font(26, "regular")
    capc = (140, 165, 185, 255) if not light else (70, 88, 108, 255)
    d.text((W / 2 - d.textlength(T["caption"], font=f_cap) / 2, 1776), T["caption"], font=f_cap, fill=capc)
    return V, ov


MUSIC_STYLES = {
    "classic": {"chords": [(110.0, 130.81, 164.81, 220.0), (87.31, 130.81, 174.61, 220.0),
                           (130.81, 164.81, 196.0, 261.63), (98.0, 146.83, 196.0, 245.0)],
                "notes": [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25],
                "step": [0.53, 0.8, 1.07], "pluck": 0.55, "pad": 0.16, "sub": 0.30, "pulse": 1.07,
                "bass_oct": 0.5, "air": 0.012, "mix": 1.15},
    "drive": {"chords": [(110.0, 130.81, 164.81, 220.0), (87.31, 130.81, 174.61, 220.0),
                          (130.81, 164.81, 196.0, 261.63), (98.0, 146.83, 196.0, 245.0)],
               "notes": [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 659.25, 783.99],
               "step": [0.26, 0.53], "pluck": 0.62, "pad": 0.12, "sub": 0.34, "pulse": 0.53,
               "bass_oct": 0.5, "air": 0.014, "mix": 1.35},
    "warm": {"chords": [(110.0, 130.81, 164.81, 220.0), (87.31, 130.81, 174.61, 220.0),
                        (130.81, 164.81, 196.0, 261.63), (98.0, 146.83, 196.0, 245.0)],
              "notes": [220.0, 261.63, 293.66, 329.63, 440.0, 523.25],
              "step": [0.8, 1.07, 1.6], "pluck": 0.4, "pad": 0.14, "sub": 0.26, "pulse": 1.6,
              "bass_oct": 0.5, "air": 0.01, "mix": 1.05},
    "major": {"chords": [(130.81, 164.81, 196.0, 261.63), (98.0, 130.81, 164.81, 196.0),
                          (87.31, 110.0, 130.81, 174.61), (65.41, 98.0, 130.81, 164.81)],
               "notes": [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99],
               "step": [0.26, 0.53], "pluck": 0.6, "pad": 0.13, "sub": 0.22, "pulse": 0.53,
               "bass_oct": 0.25, "air": 0.012, "mix": 1.3},
    "epic": {"chords": [(110.0, 130.81, 164.81, 220.0), (98.0, 130.81, 164.81, 196.0),
                        (130.81, 164.81, 196.0, 261.63), (130.81, 146.83, 174.61, 220.0)],
              "notes": [110.0, 130.81, 164.81, 196.0, 220.0],
              "step": [1.6, 2.13], "pluck": 0.0, "pad": 0.2, "sub": 0.4, "pulse": 1.6,
              "bass_oct": 0.5, "air": 0.008, "mix": 1.25},
    "uplift": {"chords": [(130.81, 164.81, 196.0, 261.63), (87.31, 110.0, 130.81, 174.61),
                          (98.0, 123.47, 146.83, 196.0), (130.81, 164.81, 196.0, 261.63),
                          (130.81, 164.81, 196.0, 261.63), (87.31, 110.0, 130.81, 174.61),
                          (98.0, 123.47, 146.83, 196.0), (130.81, 164.81, 196.0, 261.63)],
               "notes": [392.0, 440.0, 523.25, 587.33, 659.25, 783.99, 880.0, 1046.5],
               "step": [0.267, 0.4], "pluck": 0.42, "pad": 0.15, "sub": 0.22, "pulse": 0.8,
               "bass_oct": 0.25, "air": 0.02, "mix": 1.3},
    "calm": {"chords": [(130.81, 164.81, 196.0, 261.63), (98.0, 123.47, 146.83, 196.0),
                        (110.0, 130.81, 164.81, 220.0), (87.31, 130.81, 174.61, 220.0),
                        (130.81, 164.81, 196.0, 261.63), (98.0, 123.47, 146.83, 196.0),
                        (110.0, 130.81, 164.81, 220.0), (98.0, 146.83, 196.0, 245.0)],
              "notes": [196.0, 261.63, 293.66, 329.63, 392.0, 440.0],
              "step": [0.8, 1.07, 1.6], "pluck": 0.3, "pad": 0.13, "sub": 0.16, "pulse": 2.13,
              "bass_oct": 0.25, "air": 0.006, "mix": 0.8},
}


def synth_music(dur=6.4, variant="classic"):
    M = MUSIC_STYLES.get(variant, MUSIC_STYLES["classic"])
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float64) / SR
    L = np.zeros(n); R = np.zeros(n)
    chords = M["chords"]
    seg = dur / len(chords)
    pad = np.zeros(n)
    for ci, (f1, f3, f5, o1) in enumerate(chords):
        t0 = ci * seg
        wend = min(n, int((t0 + seg) * SR))
        tt = t[int(t0 * SR):wend] - t0
        env = (1 - np.cos(np.minimum(tt / 0.35, 1) * np.pi)) * 0.5
        env *= np.clip((seg - 0.3 - tt) / 0.35, 0, 1)
        mix = (np.sin(2 * np.pi * f1 * tt) + 0.62 * np.sin(2 * np.pi * f3 * tt)
               + 0.75 * np.sin(2 * np.pi * f5 * tt) + 0.2 * np.sin(2 * np.pi * o1 * tt))
        pad[int(t0 * SR):wend] += env * mix * M["pad"]
    trem = 1 + 0.05 * np.sin(2 * np.pi * 0.7 * t)
    pad *= trem
    L += pad; R += pad * 0.98
    # Sub-Bass je Akkord
    sub = np.zeros(n)
    for ci, (f1, *_ign) in enumerate(chords):
        t0 = ci * seg
        wend = min(n, int((t0 + seg) * SR))
        tt = t[int(t0 * SR):wend] - t0
        env = (1 - np.cos(np.minimum(tt / 0.35, 1) * np.pi)) * 0.5
        env *= np.clip((seg - 1.0 - tt) / 0.9, 0, 1)
        sub[int(t0 * SR):wend] += env * np.sin(2 * np.pi * f1 * M["bass_oct"] * tt) * M["sub"]
    L += sub * 0.5; R += sub * 0.5
    # Plucks
    notes = M["notes"]
    rnd = random.Random(11)
    tt = 0.0
    k = 0
    while tt < dur - 0.1:
        note = notes[k % len(notes)]
        k += 1 if rnd.random() < 0.55 else 2
        ln = min(n, int((tt + 0.5) * SR))
        st = int(tt * SR)
        pl = np.zeros(ln - st)
        pn = np.arange(ln - st) / SR
        det = 1 + rnd.uniform(-0.004, 0.004)
        pl += (np.sin(2 * np.pi * note * det * pn)
               + 0.4 * np.sin(2 * np.pi * note * 2 * det * pn)
               + 0.2 * np.sin(2 * np.pi * note * 3 * det * pn))
        pl *= np.exp(-pn * 6.5) * M["pluck"]
        (L if k % 2 == 0 else R)[st:ln] += pl
        tt += rnd.choice(M["step"])
    # Sub-Puls
    pulse = 0.0
    t0 = 0.0
    while t0 < dur:
        st = int(t0 * SR)
        ln = min(n, st + int(0.18 * SR))
        pn = np.arange(ln - st) / SR
        pp = (np.sin(2 * np.pi * (92 - 30 * pn) * pn) + 0.5 * np.sin(2 * np.pi * 55 * pn))
        pp *= np.exp(-pn * 26) * 0.8
        L[st:ln] += pp * 0.28; R[st:ln] += pp * 0.28
        t0 += M["pulse"]
    # Luft-Rauschen
    noise = np.random.default_rng(3).standard_normal(n)
    air = np.convolve(noise, np.ones(48) / 48, mode="same") * M["air"]
    L += air; R += air
    mix = np.stack([L, R], axis=1)
    mix = np.tanh(mix * M["mix"])
    mx = np.max(np.abs(mix))
    if mx > 0:
        mix = mix / mx * 0.58
    import wave
    out = os.path.join(tempfile.gettempdir(), "clipmap_music.wav")
    with wave.open(out, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((mix * 32767).astype(np.int16).tobytes())
    return out


def build_vignette():
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    dark = 130
    for i in range(220):
        a = int(dark * (i / 220) ** 2)
        d.rectangle([0, i, W, i], fill=(0, 0, 0, a))
        d.rectangle([0, H - 1 - i, W, H - i], fill=(0, 0, 0, a))
        d.rectangle([i, 0, i + 1, H], fill=(0, 0, 0, a))
        d.rectangle([W - 1 - i, 0, W - i, H], fill=(0, 0, 0, a))
    return ov


def draw_fx(full, i, V):
    d = ImageDraw.Draw(full)
    fx = V["fx"]
    if "grid" in fx:
        for gx in range(0, W, 90):
            d.line([gx, 84, gx, W + 84], fill=(70, 220, 255, 12))
        for gy in range(84, W + 84, 90):
            d.line([0, gy, W, gy], fill=(70, 220, 255, 12))
    if "scan" in fx:
        sy = 84 + (i * 40) % (W - 150)
        d.rectangle([0, sy, W, sy + 3], fill=(0, 255, 245, 16))
    if "border" in fx:
        d.rounded_rectangle([14, 98, W - 14, W + 70], radius=10, outline=(30, 42, 60, 130), width=3)
    if "sparkle" in fx:
        rnd = random.Random(i)
        for _ in range(14):
            sx = rnd.randint(20, W - 20)
            sy = rnd.randint(100, W + 60)
            d.ellipse([sx, sy, sx + 6, sy + 6], fill=(255, 255, 255, 100))
    return full


def build(prompt, title, out, duration, lang="de", variant="classic", custom=None, focus=None):
    world = load_world_map()
    pops = load_pixels()
    tmp = tempfile.mkdtemp(prefix="clipmap")
    V = VARIANT.get(variant, VARIANT["classic"])
    try:
        V, ov = build_overlay(title, lang, variant, custom)
        base = world.resize((W, W), Image.LANCZOS).convert("RGB")
        from PIL import ImageEnhance
        base = ImageEnhance.Color(base).enhance(V["map"]["saturation"])
        base = ImageEnhance.Brightness(base).enhance(V["map"]["brightness"])
        base = ImageEnhance.Contrast(base).enhance(V["map"]["contrast"])
        base = base.convert("RGB")
        MAP_Y = 84
        frames = duration * FPS
        fd = os.path.join(tmp, "frames")
        os.makedirs(fd)
        vignette = build_vignette() if "vignette" in V["fx"] else None
        px = py = None
        if focus:
            px, py = ll_from_latlon(focus[0], focus[1])
            zoom_end = focus[2] if len(focus) > 2 else 2.4
        for i in range(frames):
            tnow = i / FPS
            u = smoothstep(min(1.0, tnow / duration))
            if focus:
                crop = int(W / (1.0 + (zoom_end - 1.0) * u))
                ex0 = max(0, min(W - crop, int(px - crop / 2)))
                ey0 = max(0, min(W - crop, int(py - crop / 2)))
                x0 = int(ex0 * u)
                y0 = int(ey0 * u)
            else:
                crop = int(W / (1.0 + 0.06 * u))
                x0 = 0
                y0 = int((W - crop) / 2) + int(8 * u)
            scale = W / crop
            frame = base.crop((x0, y0, x0 + crop, y0 + crop)).resize((W, W), Image.LANCZOS)
            layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
            d = ImageDraw.Draw(layer)
            inset = 26
            mapw = W - 2 * inset
            gs = V["px"]["glow"]; rad = V["px"]["rad"]
            for p in pops:
                if p["t"] > tnow:
                    continue
                pr = min(1.0, (tnow - p["t"]) / 0.32)
                xm = inset + (p["lon"] + 180) / 360.0 * mapw
                yn = (1 - math.log(math.tan(math.pi / 4 + math.radians(p["lat"]) / 2)) / math.pi) / 2
                ym = inset + yn * mapw
                x = (xm - x0) * scale
                y = (ym - y0) * scale
                y = max(6, min(W - 6, y))
                grow = 2 + 12 * (0.4 + 0.6 * pr) * (gs / 1.0 if gs > 1 else 1)
                huec = hue(p["name"] if not p["real"] else p.get("pixel_id", 1))
                col = hsl_to_rgb(huec, V["px"]["sat"], V["px"]["light"])
                if pr < 1.0:
                    rr = 8 + 46 * pr
                    alpha = int(220 * (1 - pr))
                    d.rounded_rectangle([x - rr, y - rr, x + rr, y + rr], radius=rr,
                                        outline=col + (alpha,), width=5)
                for g, ga in ((44, 0.10), (30, 0.18), (20, 0.30), (14, 0.45)):
                    if pr * grow > g * 0.6:
                        d.rounded_rectangle([x - g / 2, y - g / 2, x + g / 2, y + g / 2],
                                            radius=g / 2, fill=col + (int(ga * 255 * pr),))
                s = grow / (2 if V["name"] == "Paper Minimal" else 1)
                d.rounded_rectangle([x - s, y - s, x + s, y + s], radius=3 if not V["light"] else 2,
                                    fill=col + (255,), outline=hsl_to_rgb(huec, V["px"]["sat"], min(0.86, V["px"]["light"] + 0.2)) + (255,),
                                    width=3 if not V["light"] else 2)
            comp = Image.alpha_composite(frame.convert("RGBA"), layer)
            full = Image.new("RGBA", (W, H), V["bg"])
            full.paste(comp, (0, MAP_Y))
            full = draw_fx(full, i, V) if V["fx"] else full
            if vignette:
                full = Image.alpha_composite(full, vignette)
            full = Image.alpha_composite(full, ov)
            full.convert("RGB").save(os.path.join(fd, f"f{i:04d}.png"))
        # Video
        ff = os.environ.get("FFMPEG") or "ffmpeg"
        silent = os.path.join(tmp, "silent.mp4")
        subprocess.run([ff, "-y", "-framerate", str(FPS), "-i", os.path.join(fd, "f%04d.png"),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", silent],
                       check=True, capture_output=True)
        audio = synth_music(duration + 0.4, variant)
        ad = os.path.join(tmp, "music.m4a")
        subprocess.run([ff, "-y", "-i", audio,
                        "-af", "loudnorm=I=-17:TP=-1.5:LRA=13,aresample=48000",
                        "-ac", "2", "-c:a", "aac", "-b:a", "160k", ad],
                       check=True, capture_output=True)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        subprocess.run([ff, "-y", "-i", silent, "-i", ad,
                        "-af", "afade=t=out:st={}:d=0.5".format(duration - 0.6),
                        "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart",
                        "-shortest", out],
                       check=True, capture_output=True)
        print("OK: " + out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def build_poster(title, out, height=1350, lang="de", custom=None):
    L = LANG.get(lang, LANG["de"])
    PW = 1080
    world = load_world_map()
    pops = load_pixels()
    base = world.resize((PW, PW), Image.LANCZOS).convert("RGB")
    layer = Image.new("RGBA", (PW, PW), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    inset = 26
    mapw = PW - 2 * inset
    for p in pops:
        x = inset + (p["lon"] + 180) / 360.0 * mapw
        yn = (1 - math.log(math.tan(math.pi / 4 + math.radians(p["lat"]) / 2)) / math.pi) / 2
        y = max(6, min(PW - 6, inset + yn * mapw))
        huec = hue(p["name"] if not p["real"] else p.get("pixel_id", 1))
        col = hsl_to_rgb(huec, 0.92, 0.55)
        for g, ga in ((44, 0.10), (30, 0.18), (20, 0.30), (14, 0.45)):
            d.rounded_rectangle([x - g / 2, y - g / 2, x + g / 2, y + g / 2],
                                radius=g / 2, fill=col + (int(ga * 255),))
        d.rounded_rectangle([x - 14, y - 14, x + 14, y + 14], radius=3,
                            fill=col + (255,), outline=hsl_to_rgb(huec, 0.92, 0.82) + (255,), width=3)
    mapc = Image.alpha_composite(base.convert("RGBA"), layer)
    canvas = Image.new("RGBA", (PW, height), NAVY)
    canvas.paste(mapc, (0, 0))
    d = ImageDraw.Draw(canvas)

    # Badge
    f_badge = font(38, "medium")
    badge_txt = "PIXELMAPS.ORG"
    bw = d.textlength(badge_txt, font=f_badge) + 56
    d.rounded_rectangle([36, 40, 36 + bw, 116], radius=38,
                        fill=(8, 20, 38, 205), outline=(120, 220, 255, 220), width=2)
    d.text((68, 55), badge_txt, font=f_badge, fill=(150, 230, 255, 255))

    # Textbereich unten ausleuchten (Kontrast)
    for i in range(max(0, PW - 330), PW):
        a = int(230 * (i - (PW - 330)) / 330)
        d.rectangle([0, i, PW, i], fill=(5, 9, 17, a))

    eyebrow = (custom or {}).get("eyebrow") or L["eyebrow"]
    claim = [tuple(x) for x in ((custom or {}).get("claim") or L["claim"])]
    caption = (custom or {}).get("caption") or L["caption"]

    f_ey = font(26, "medium")
    draw_tracked(d, eyebrow.replace("   ", " \u00b7 "), f_ey, PW / 2, 1110,
                 (86, 225, 236, 255), tracking=6)

    y = 1180
    line_h = {46: 62, 64: 86, 40: 54, 42: 56, 54: 72, 56: 74, 58: 78, 62: 84}
    for text, style, size, kind in claim:
        f = font(size, style)
        tx = d.textlength(text, font=f) / 2
        if kind == "gradient":
            draw_gradient(canvas, d, text, f, PW / 2, y, (120, 245, 255, 255), (255, 255, 255, 255))
        elif kind in ("softdark", "soft"):
            d.text((PW / 2 - tx, y), text, font=f, fill=(70, 105, 135, 255))
        else:
            d.text((PW / 2 - tx, y), text, font=f, fill=(255, 255, 255, 255))
        y += line_h.get(size, size + 20)

    cta_y = y + 26
    f_cta = font(50, "demi")
    cta = "pixelmaps.org"
    cw = d.textlength(cta, font=f_cta) + 64
    d.rounded_rectangle([(PW - cw) / 2, cta_y, (PW + cw) / 2, cta_y + 88],
                        radius=44, fill=(0, 180, 210, 240))
    d.text(((PW - d.textlength(cta, font=f_cta)) / 2, cta_y + 12), cta, font=f_cta,
           fill=(255, 253, 246, 255))

    f_cap = font(26, "regular")
    cap_y = min(cta_y + 108, height - 40)
    d.text((PW / 2 - d.textlength(caption, font=f_cap) / 2, cap_y), caption, font=f_cap,
           fill=(140, 165, 185, 255))

    canvas.convert("RGB").save(out, "JPEG", quality=90)
    print("OK: " + out)


def build_story(out, duration=16.8, scenes=None, cities=None, brand=None, music="uplift", lang="de"):
    """Daten-getriebene Story: Szenen + Kamera-Flyover + Stadt-Marker + Musik.
    Defaults = bisherige 6-Szenen-Englisch-Story, damit altes Verhalten bleibt."""
    world = load_world_map()
    pops = load_pixels()
    base = world.resize((W, W), Image.LANCZOS).convert("RGB")
    MAP_Y = 84
    ins = 26
    mapw = W - 2 * ins

    def ll(lat, lon):
        x = ins + (lon + 180) / 360.0 * mapw
        yn = (1 - math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) / math.pi) / 2
        return x, max(6, min(W - 6, ins + yn * mapw))

    if cities is None:
        cities = {"New York": (40.71, -74.0), "Tokyo": (35.68, 139.7),
                  "Berlin": (52.52, 13.4), "Rio": (-22.9, -43.17)}
    CITIES = {name: ll(la, lo) for name, (la, lo) in cities.items()}

    if scenes is None:
        scenes = [
            (0.0, 2.0, "text", ["THE WORLD IS A BIG PLACE..."], 62),
            (2.0, 4.6, "text", ["BUT EVERYONE HAS A PLACE", "THEY CALL HOME."], 58),
            (4.6, 6.1, "city", "New York", 56),
            (6.1, 7.6, "city", "Tokyo", 56),
            (7.6, 9.1, "city", "Berlin", 56),
            (9.1, 10.6, "city", "Rio", 56),
            (10.6, 12.8, "text", ["WHERE ARE YOU FROM?"], 64),
            (12.8, 15.0, "text", ["COMMENT YOUR CITY BELOW!"], 64),
            (15.0, duration, "brand", [], 0),
        ]
    brand = brand or {"title": "PIXELMAPS.ORG", "sub": "ONE PLANET. ONE PIXEL."}

    # Kamera-Pfad aus Szenen aufbauen; bei Stadt-Szenen auf die Stadt zoomen
    worldcam = (540.0, 540.0, 1080.0)
    bounds = sorted(set([0.0, duration] + [s[0] for s in scenes] + [s[1] for s in scenes]))
    keys_ts = bounds
    keys_cam = []
    for t in bounds:
        cam = worldcam
        for (s0, s1, kind, payload, _tip) in scenes:
            if kind == "city" and s0 <= t < s1:
                cname = payload[0] if isinstance(payload, (list, tuple)) else payload
                if cname in CITIES:
                    cx, cy = CITIES[cname]
                    cam = (cx, cy, 520.0)
                    break
        keys_cam.append(cam)

    def smooth(u):
        return u * u * (3 - 2 * u)

    def camel_frame(t):
        for k in range(len(keys_ts) - 1):
            if t <= keys_ts[k + 1]:
                u = smooth(min(1, max(0, (t - keys_ts[k]) / (keys_ts[k + 1] - keys_ts[k]))))
                a, b = keys_cam[k], keys_cam[k + 1]
                return tuple(a[i] + (b[i] - a[i]) * u for i in range(3))
        return keys_cam[-1]

    def txt_layer(lines, size, y0, accent=True):
        d_ = ImageDraw.Draw(Image.new("L", (1, 1)))
        wmax = max(d_.textlength(t, font=font(size, "bold")) for t in lines) if lines else 0
        if wmax > 1020:
            size = int(size * 1020 / wmax)
        f = font(size, "bold")
        adv = int(size * 1.28)
        total = adv * len(lines)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        dl = ImageDraw.Draw(layer)
        widths = [dl.textlength(t, font=f) for t in lines]
        box_w = int(max(widths)) + 96
        box_h = total + 64
        bx0 = (W - box_w) / 2
        by0 = y0 - box_h / 2
        dl.rounded_rectangle([bx0, by0, bx0 + box_w, by0 + box_h], radius=36,
                             fill=(5, 9, 17, 168), outline=(120, 220, 255, 70), width=2)
        cy = by0 + 32
        for text, wd in zip(lines, widths):
            tx = (W - wd) / 2
            dl.text((tx, cy + 3), text, font=f, fill=(0, 210, 220, 90))
            if accent:
                draw_gradient(layer, dl, text, f, W / 2, cy, (140, 240, 255, 255), (255, 255, 255, 255))
            else:
                dl.text((tx, cy), text, font=f, fill=(255, 255, 255, 255))
            cy += adv
        return layer

    def brand_layer(cur_t, t0, t1):
        step = min(1, (cur_t - t0) / 0.8)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        dl = ImageDraw.Draw(layer)
        f = font(80, "bold")
        wtxt = brand.get("title", "PIXELMAPS.ORG")
        wd = dl.textlength(wtxt, font=f)
        f1 = font(28, "regular")
        sub = brand.get("sub", "ONE PLANET. ONE PIXEL.")
        sw = dl.textlength(sub, font=f1)
        box_w = max(wd, sw) + 120
        box_h = 250
        bx0 = (W - box_w) / 2
        by0 = 880 - box_h / 2
        dl.rounded_rectangle([bx0, by0, bx0 + box_w, by0 + box_h], radius=40,
                             fill=(5, 9, 17, 200), outline=(120, 220, 255, 90), width=2)
        draw_gradient(layer, dl, wtxt, f, W / 2, 880 + 10,
                      (140, 240, 255, 255), (255, 255, 255, 255))
        dl.text((W / 2 - sw / 2, 1014), sub, font=f1, fill=(166, 240, 255, 235))
        if step < 1:
            a = layer.getchannel("A").point(lambda v: int(v * step))
            layer.putalpha(a)
        return layer

    tmp = tempfile.mkdtemp(prefix="story")
    try:
        frames = int(duration * FPS)
        fd = os.path.join(tmp, "frames")
        os.makedirs(fd)
        for i in range(frames):
            tnow = i / FPS
            cx, cy, crop = camel_frame(tnow)
            crop = max(360, min(W, int(crop)))
            x0 = max(0, min(W - crop, int(cx - crop / 2)))
            y0 = max(0, min(W - crop, int(cy - crop / 2)))
            mapc = base.crop((x0, y0, x0 + crop, y0 + crop)).resize((W, W), Image.LANCZOS)
            layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
            d = ImageDraw.Draw(layer)
            for p in pops:
                x = ins + (p["lon"] + 180) / 360.0 * mapw
                yn = (1 - math.log(math.tan(math.pi / 4 + math.radians(p["lat"]) / 2)) / math.pi) / 2
                y = max(6, min(W - 6, ins + yn * mapw))
                huec = hue(p["name"] if not p["real"] else p.get("pixel_id", 1))
                col = hsl_to_rgb(huec, 0.92, 0.58)
                for g, ga in ((36, 0.08), (24, 0.16), (14, 0.3), (9, 0.42)):
                    d.rounded_rectangle([x - g / 2, y - g / 2, x + g / 2, y + g / 2],
                                        radius=g / 2, fill=col + (int(ga * 255),))
                d.rounded_rectangle([x - 6, y - 6, x + 6, y + 6], radius=3,
                                    fill=col + (255,), outline=hsl_to_rgb(huec, 0.92, 0.84) + (255,), width=2)
            camc = None
            cur = None
            for (s0, s1, kind, payload, tip) in scenes:
                if s0 <= tnow < s1:
                    cur = (s0, s1, kind, payload, tip)
                    break
            if cur and cur[2] == "city":
                px, py = CITIES[cname]
                camc = (px, py)
                pr = 0.5 + 0.5 * math.sin(2 * math.pi * 1.8 * tnow + 0.4)
                acc = (120, 245, 255)
                for g, ga in ((90, 40), (62, 55), (42, 70), (28, 90)):
                    r = g * (0.8 + 0.4 * pr)
                    d.rounded_rectangle([px - r, py - r, px + r, py + r], radius=r,
                                        outline=acc + (int(ga * pr),), width=6)
                d.ellipse([px - 7, py - 7, px + 7, py + 7], fill=acc + (255,))
            comp = Image.alpha_composite(mapc.convert("RGBA"), layer)
            full = Image.new("RGBA", (W, H), NAVY)
            full.paste(comp, (0, MAP_Y))
            # Szene-Overlay
            if cur:
                s0, s1, kind, payload, tip = cur
                if kind == "text":
                    fade = min(1, (tnow - s0) / 0.25, (s1 - tnow) / 0.25)
                    if fade > 0:
                        ov = txt_layer(payload, tip, 900)
                        if fade < 1:
                            a = ov.getchannel("A").point(lambda v: int(v * fade))
                            ov.putalpha(a)
                        full = Image.alpha_composite(full, ov)
                elif kind == "city":
                    fade = min(1, (tnow - s0) / 0.22, (s1 - tnow) / 0.22)
                    if fade > 0:
                        lines = payload[1] if isinstance(payload, (list, tuple)) and len(payload) > 1 else ([payload + "?"] if isinstance(payload, str) else [str(payload)])
                        if isinstance(payload, str):
                            lines = [payload]
                        if isinstance(payload, (list, tuple)) and len(payload) > 0 and isinstance(payload[0], str):
                            lines = list(payload)
                        ov = txt_layer(lines, tip, 930, accent=False)
                        if fade < 1:
                            a = ov.getchannel("A").point(lambda v: int(v * fade))
                            ov.putalpha(a)
                        full = Image.alpha_composite(full, ov)
                elif kind == "brand":
                    full = Image.alpha_composite(full, brand_layer(tnow, s0, s1))
            # sanftes Ein- und Ausblenden
            fade_in = min(1, tnow / 0.4)
            fade_out = min(1, (duration - tnow) / 0.4)
            black = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            a = int(max(0, 1.0 - min(fade_in, fade_out)) * 255)
            if a > 0:
                black.putalpha(a)
                full = Image.alpha_composite(full, black)
            full.convert("RGB").save(os.path.join(fd, f"f{i:04d}.png"))
        ff = os.environ.get("FFMPEG") or "ffmpeg"
        silent = os.path.join(tmp, "silent.mp4")
        subprocess.run([ff, "-y", "-framerate", str(FPS), "-i", os.path.join(fd, "f%04d.png"),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", silent],
                       check=True, capture_output=True)
        audio = synth_music(duration + 0.4, music)
        ad = os.path.join(tmp, "music.m4a")
        subprocess.run([ff, "-y", "-i", audio,
                        "-af", "loudnorm=I=-17:TP=-1.5:LRA=13,aresample=48000",
                        "-ac", "2", "-c:a", "aac", "-b:a", "160k", ad],
                       check=True, capture_output=True)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        subprocess.run([ff, "-y", "-i", silent, "-i", ad,
                        "-af", "afade=t=out:st={}:d=0.5".format(duration - 0.6),
                        "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart",
                        "-shortest", out],
                       check=True, capture_output=True)
        print("OK: " + out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", default="")
    ap.add_argument("--title", default="")
    ap.add_argument("--subtitle", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--duration", type=int, default=6)
    ap.add_argument("--lang", default="de", choices=list(LANG.keys()))
    ap.add_argument("--variant", default="classic", choices=list(VARIANT.keys()))
    ap.add_argument("--poster", action="store_true")
    ap.add_argument("--story", action="store_true")
    ap.add_argument("--claim", default=None, help="JSON: eyebrow/claim/caption")
    ap.add_argument("--scenes", default=None, help="JSON: Story-Szenen")
    ap.add_argument("--focus", default=None, help="lat,lon[,zoom] – Kamera zoomt auf den Punkt")
    a = ap.parse_args()
    if a.story:
        build_story(a.out, 16.8 if a.duration == 6 else float(a.duration))
    elif a.scenes:
        with open(a.scenes, encoding="utf-8") as f:
            s = json.load(f)
        build_story(a.out,
                    float(s.get("duration", 16.8)),
                    scenes=[tuple(x) for x in s.get("scenes", [])],
                    cities=s.get("cities"),
                    brand=s.get("brand"),
                    music=s.get("music", "uplift"),
                    lang=s.get("lang", a.lang))
    elif a.poster:
        custom = None
        if a.claim:
            with open(a.claim, encoding="utf-8") as f:
                custom = json.load(f)
        build_poster(a.title, a.out, lang=a.lang, custom=custom)
    else:
        custom = None
        if a.claim:
            with open(a.claim, encoding="utf-8") as f:
                custom = json.load(f)
        focus = None
        if a.focus:
            parts = a.focus.split(",")
            focus = (float(parts[0]), float(parts[1]),
                     float(parts[2]) if len(parts) > 2 else 2.4)
        build(a.prompt, a.title, a.out, a.duration, lang=a.lang, variant=a.variant,
              custom=custom, focus=focus)


if __name__ == "__main__":
    main()