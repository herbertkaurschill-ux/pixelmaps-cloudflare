#!/usr/bin/env python3
"""
short.py – baut einen Beispiel-Short im neuen Format.

Ablauf (10 s):
  0,0–1,0  Hook: "DEINE STRASSE." – Karte bewegt sich sofort
  1,0–2,1  Adresssuche: "Kollwitzstraße 1, Berlin" tippt sich selbst
  2,1–3,3  Schnitt auf die echte Karte von Berlin, Zoom, Pixel schlägt ein
  3,3–5,2  Preis: 1 €, einmal zahlen, für immer
  5,2–7,4  Ehrliche Zahl: 14 von 1 Milliarde
  7,4–9,5  CTA: pixelmaps.org
  9,5–10   zurück zum Hook (Loop)

Nutzung:
  python3 scripts/short.py --out public/clips/examples/short-de.mp4
  python3 scripts/short.py --stills 0.4,1.6,2.9,4.2,6.0,8.2 --out /tmp/x.mp4
"""
import argparse, math, os, shutil, subprocess, sys, tempfile, urllib.request, wave
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clipmap as cm

W, H, FPS, SR = 1080, 1920, 30, 44100
DUR = 10.0

NAVY = (5, 9, 17)
TEAL = (52, 245, 197)
TEAL_DIM = (30, 158, 132)
WHITE = (255, 255, 255)
MUTED = (176, 194, 214)

SAFE_TOP, SAFE_BOTTOM = 180, 1400
SELLING, TOTAL = 14, 1_000_000_000

# Per configure() ueberschreibbar (publish-day.sh gibt den Hook des Posts mit).
HOOK = "DEINE STRASSE."
SUB = "Für 1 €. Für immer."
LANG = "de"
TARGET = {"city": "BERLIN", "lat": 52.5200, "lon": 13.4050}
ADDRESS = "Kollwitzstraße 1, Berlin"

# Städte je Sprache: der Short spielt dort, wo der Zuschauer zuhause ist.
CITIES = {
    "de": ("BERLIN", 52.5200, 13.4050, "Kollwitzstraße 1, Berlin"),
    "en": ("LONDON", 51.5072, -0.1276, "Baker Street 221, London"),
    "es": ("MADRID", 40.4168, -3.7038, "Gran Vía 1, Madrid"),
    "fr": ("PARIS", 48.8566, 2.3522, "Rue de Rivoli 1, Paris"),
    "it": ("MILANO", 45.4642, 9.1900, "Via Torino 1, Milano"),
    "pt": ("SÃO PAULO", -23.5505, -46.6333, "Avenida Paulista 1000, São Paulo"),
    "tr": ("İSTANBUL", 41.0082, 28.9784, "İstiklal Caddesi 1, İstanbul"),
    "ru": ("МОСКВА", 55.7558, 37.6173, "Тверская улица 1, Москва"),
    "hi": ("दिल्ली", 28.6139, 77.2090, "कनॉट प्लेस, नई दिल्ली"),
    "zh": ("上海", 31.2304, 121.4737, "南京东路 1, 上海"),
}

# Himmelsrichtungen je Sprache: (Norden, Sueden) und (Osten, Westen).
# Ohne Vorzeichenpruefung stand bei London "E" und bei Sao Paulo "N".
DIRS = {
    "de": (("N", "S"), ("O", "W")),
    "en": (("N", "S"), ("E", "W")),
    "es": (("N", "S"), ("E", "O")),
    "fr": (("N", "S"), ("E", "O")),
    "it": (("N", "S"), ("E", "O")),
    "pt": (("N", "S"), ("L", "O")),
    "tr": (("K", "G"), ("D", "B")),
    "ru": (("с.ш.", "ю.ш."), ("в.д.", "з.д.")),
    "hi": (("उत्तर", "दक्षिण"), ("पूर्व", "पश्चिम")),
    "zh": (("北纬", "南纬"), ("东经", "西经")),
}

L = {
    "de": {
        "hook": "DEINE STRASSE.",
        "sub": "Für 1 €. Für immer.",
        "pay": "einmal zahlen. für immer drin.",
        "details": "Name, Nachricht und Urkunde als PDF.",
        "price_top": "1 €",
        "today": "STAND HEUTE",
        "ofbillion": "{n} von 1 Milliarde",
        "share": "{pct} % der Karte sind vergeben.",
        "cta_top": "Deine Straße suchen:",
        "cta_foot": "1 € · kein Abo · für immer",
        "found": "Gefunden · {city}",
        "coords": "{city} · {lat}° {ns}  {lon}° {ew}",
        "dec": ",",
    },
    "en": {
        "hook": "YOUR STREET.",
        "sub": "€1. Yours forever.",
        "pay": "pay once. yours forever.",
        "details": "Name, message and a PDF certificate.",
        "price_top": "€1",
        "today": "TODAY",
        "ofbillion": "{n} of 1 billion",
        "share": "{pct}% of the map is taken.",
        "cta_top": "Find your street:",
        "cta_foot": "€1 · no subscription · forever",
        "found": "Found · {city}",
        "coords": "{city} · {lat}° {ns}  {lon}° {ew}",
        "dec": ".",
    },
    "es": {
        "hook": "TU CALLE.",
        "sub": "1 €. Para siempre.",
        "pay": "pagas una vez. es tuyo para siempre.",
        "details": "Nombre, mensaje y certificado en PDF.",
        "price_top": "1 €",
        "today": "HOY",
        "ofbillion": "{n} de 1.000 millones",
        "share": "{pct} % del mapa está ocupado.",
        "cta_top": "Busca tu calle:",
        "cta_foot": "1 € · sin suscripción · para siempre",
        "found": "Encontrado · {city}",
        "coords": "{city} · {lat}° {ns}  {lon}° {ew}",
        "dec": ",",
    },
    "fr": {
        "hook": "TA RUE.",
        "sub": "1 €. Pour toujours.",
        "pay": "un seul paiement. à toi pour toujours.",
        "details": "Nom, message et certificat en PDF.",
        "price_top": "1 €",
        "today": "AUJOURD'HUI",
        "ofbillion": "{n} sur 1 milliard",
        "share": "{pct} % de la carte est prise.",
        "cta_top": "Trouve ta rue :",
        "cta_foot": "1 € · sans abonnement · pour toujours",
        "found": "Trouvé · {city}",
        "coords": "{city} · {lat}° {ns}  {lon}° {ew}",
        "dec": ",",
    },
    "it": {
        "hook": "LA TUA VIA.",
        "sub": "1 €. Per sempre.",
        "pay": "paghi una volta. è tuo per sempre.",
        "details": "Nome, messaggio e certificato in PDF.",
        "price_top": "1 €",
        "today": "OGGI",
        "ofbillion": "{n} su 1 miliardo",
        "share": "{pct} % della mappa è occupato.",
        "cta_top": "Cerca la tua via:",
        "cta_foot": "1 € · nessun abbonamento · per sempre",
        "found": "Trovato · {city}",
        "coords": "{city} · {lat}° {ns}  {lon}° {ew}",
        "dec": ",",
    },
    "pt": {
        "hook": "A TUA RUA.",
        "sub": "1 €. Para sempre.",
        "pay": "pagas uma vez. é teu para sempre.",
        "details": "Nome, mensagem e certificado em PDF.",
        "price_top": "1 €",
        "today": "HOJE",
        "ofbillion": "{n} de 1 mil milhões",
        "share": "{pct} % do mapa está ocupado.",
        "cta_top": "Procura a tua rua:",
        "cta_foot": "1 € · sem subscrição · para sempre",
        "found": "Encontrado · {city}",
        "coords": "{city} · {lat}° {ns}  {lon}° {ew}",
        "dec": ",",
    },
    "tr": {
        "hook": "SENİN SOKAĞIN.",
        "sub": "1 €. Sonsuza dek.",
        "pay": "tek ödeme. sonsuza dek senin.",
        "details": "İsim, mesaj ve PDF sertifika.",
        "price_top": "1 €",
        "today": "BUGÜN",
        "ofbillion": "1 milyarda {n}",
        "share": "Haritanın %{pct}'ü dolu.",
        "cta_top": "Sokağını bul:",
        "cta_foot": "1 € · abonelik yok · sonsuza dek",
        "found": "Bulundu · {city}",
        "coords": "{city} · {lat}° {ns}  {lon}° {ew}",
        "dec": ",",
    },
    "ru": {
        "hook": "ТВОЯ УЛИЦА.",
        "sub": "1 €. Навсегда.",
        "pay": "один платёж. навсегда твой.",
        "details": "Имя, сообщение и сертификат в PDF.",
        "price_top": "1 €",
        "today": "СЕГОДНЯ",
        "ofbillion": "{n} из 1 миллиарда",
        "share": "занято {pct} % карты.",
        "cta_top": "Найди свою улицу:",
        "cta_foot": "1 € · без подписки · навсегда",
        "found": "Найдено · {city}",
        "coords": "{city} · {lat}° {ns}  {lon}° {ew}",
        "dec": ",",
    },
    "hi": {
        # Kein „€“: die Devanagari-Schrift hat kein Euro-Zeichen.
        "hook": "तुम्हारी गली।",
        "sub": "1 यूरो में। हमेशा के लिए।",
        "pay": "एक बार भुगतान। हमेशा तुम्हारा।",
        "details": "नाम, संदेश और PDF सर्टिफिकेट।",
        "price_top": "1 यूरो",
        "today": "आज",
        "ofbillion": "1 अरब में से {n}",
        "share": "नक्शे का {pct} % भरा है।",
        "cta_top": "अपनी गली खोजो:",
        "cta_foot": "1 यूरो · कोई सब्सक्रिप्शन नहीं · हमेशा",
        "found": "मिल गया · {city}",
        "coords": "{city} — {ns} {lat}  {ew} {lon}",
        "dec": ".",
    },
    "zh": {
        "hook": "你的街道。",
        "sub": "1 欧元，永久保留。",
        "pay": "一次付费，永远属于你。",
        "details": "名字、留言和 PDF 证书。",
        "price_top": "1 €",
        "today": "今天",
        "ofbillion": "10 亿中的 {n} 个",
        "share": "地图仅被占用 {pct}%。",
        "cta_top": "搜索你的街道：",
        "cta_foot": "1 欧元 · 无订阅 · 永久",
        "found": "找到了 · {city}",
        "coords": "{city} · {ns} {lat}°  {ew} {lon}°",
        "dec": ".",
    },
}

# Schrift je Schrift-System: Helvetica Neue hat kein Devanagari und kein CJK.
FONT_LATIN = "/System/Library/Fonts/HelveticaNeue.ttc"
if not os.path.exists(FONT_LATIN):
    FONT_LATIN = "/System/Library/Fonts/Helvetica.ttc"
FONT_DEV = "/System/Library/Fonts/Supplemental/Devanagari Sangam MN.ttc"
FONT_CJK = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
SCRIPT_FONT = {"hi": (FONT_DEV, 1), "zh": (FONT_CJK, 0)}
FONT_CURRENT = (FONT_LATIN, 1)


# ────────────────────────────── Text ──────────────────────────────
_tiles = {}


def F(size, bold=True):
    path, bold_idx = FONT_CURRENT
    idx = bold_idx if bold else 0
    if not os.path.exists(path):
        path, idx = FONT_LATIN, (1 if bold else 0)
    return ImageFont.truetype(path, int(size), index=idx)


def measure(txt, size, bold=True, tracking=0.0):
    f = F(size, bold)
    d = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    return sum(d.textlength(c, font=f) + tracking for c in txt) - (tracking if txt else 0)


def fit(txt, size, max_w, bold=True, tracking=0.0):
    while size > 16 and measure(txt, size, bold, tracking) > max_w:
        size -= 2
    return size


def tile(txt, size, bold=True, fill=WHITE, grad=None, tracking=0.0, shadow=0.7):
    key = (txt, size, bold, fill, grad, tracking, shadow, FONT_CURRENT[0])
    if key in _tiles:
        return _tiles[key]
    pad = int(size * 0.4)
    f = F(size, bold)
    d0 = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    widths = [d0.textlength(c, font=f) + tracking for c in txt]
    tw = int(sum(widths) - tracking) if txt else 1
    asc, desc = f.getmetrics()
    img = Image.new("RGBA", (tw + 2 * pad, asc + desc + 2 * pad), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x = pad
    base = (255, 255, 255, 255) if grad else tuple(fill) + (255,)
    for c, w in zip(txt, widths):
        d.text((x, pad), c, font=f, fill=base)
        x += w
    if grad:
        mask = img.split()[3]
        g = Image.new("RGBA", img.size)
        gd = ImageDraw.Draw(g)
        for yy in range(img.size[1]):
            t = yy / max(1, img.size[1] - 1)
            col = tuple(int(grad[0][i] + (grad[1][i] - grad[0][i]) * t) for i in range(3))
            gd.line([(0, yy), (img.size[0], yy)], fill=col + (255,))
        g.putalpha(mask)
        img = g
    if shadow > 0:
        a = img.split()[3].point(lambda v: int(v * shadow))
        sh = Image.new("RGBA", img.size, (0, 0, 0, 255))
        sh.putalpha(a)
        sh = sh.filter(ImageFilter.GaussianBlur(max(2, size * 0.10)))
        out = Image.new("RGBA", img.size, (0, 0, 0, 0))
        out.paste(sh, (0, int(size * 0.08)), sh.split()[3])
        out.paste(img, (0, 0), img.split()[3])
        img = out
    _tiles[key] = img
    return img


def comp(dst, img, xy=(0, 0)):
    x, y = int(xy[0]), int(xy[1])
    if img.mode == "RGBA":
        dst.paste(img.convert("RGB"), (x, y), img.split()[3])
    else:
        dst.paste(img.convert("RGB"), (x, y))
    return dst


def put(frame, img, y, alpha=1.0, cx=None):
    if alpha <= 0.01:
        return
    if alpha < 1.0:
        img = img.copy()
        img.putalpha(img.split()[3].point(lambda v: int(v * alpha)))
    comp(frame, img, ((cx if cx is not None else W / 2) - img.width / 2, y - img.height / 2))


# Zeichen, die die jeweilige Schrift nicht hat (sonst Kaestchen im Video).
GLYPH_FIX = {
    "hi": {"€": "यूरो", "·": "-", "°": ""},
}


def fix_glyphs(txt):
    for a, b in GLYPH_FIX.get(LANG, {}).items():
        txt = txt.replace(a, b)
    return txt


def line(frame, txt, size, y, fill=WHITE, alpha=1.0, bold=True, grad=None,
         max_w=960, tracking=0.0):
    if alpha <= 0.01 or not txt:
        return
    txt = fix_glyphs(txt)
    size = fit(txt, size, max_w, bold, tracking)
    put(frame, tile(txt, size, bold, fill, grad, tracking), y, alpha)


def wrap(txt, size, max_w, bold=True):
    words, lines, cur = txt.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if measure(t, size, bold) <= max_w or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def draw_hook(frame, cy, size, alpha, max_w=980, color=WHITE, txt=None):
    """Hook als 1–2 Zeilen, automatisch verkleinert, bis er passt."""
    txt = fix_glyphs((txt or HOOK).strip())
    s = size
    lines = wrap(txt, s, max_w)
    while s > 44 and (len(lines) > 2 or any(measure(l, s) > max_w for l in lines)):
        s -= 4
        lines = wrap(txt, s, max_w)
    lh = s * 1.06
    y0 = cy - (len(lines) - 1) * lh / 2
    for i, ln in enumerate(lines):
        line(frame, ln, s, y0 + i * lh, color, alpha, max_w=max_w)
    # Unterkante inkl. Unterlaengen: line() zentriert vertikal, deshalb
    # reicht 0.55*s nicht — sonst sitzt die Unterzeile im Text.
    return y0 + (len(lines) - 1) * lh + s * 0.64


def ease(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def lerp(a, b, t):
    return a + (b - a) * t


def win(t, start, end, fade=0.22):
    if t < start or t > end:
        return 0.0
    return min(1.0, (t - start) / fade, (end - t) / fade)


# ────────────────────────────── Karten ──────────────────────────────
def nightify(img, sat=0.7, bright=0.5, contrast=1.2, tint=0.14):
    img = ImageEnhance.Color(img).enhance(sat)
    img = ImageEnhance.Brightness(img).enhance(bright)
    img = ImageEnhance.Contrast(img).enhance(contrast)
    if tint:
        img = Image.blend(img, Image.new("RGB", img.size, NAVY), tint)
    return img


def deg2num(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def cache_root():
    """Dauerhafter Cache (nicht /tmp): macOS raeumt /tmp beim Neustart leer,
    dann muesste der 09:10-Lauf alle Kacheln neu von OSM holen."""
    base = os.environ.get("PIXELMAPS_CACHE")
    if not base:
        if sys.platform == "darwin":
            base = os.path.join(os.path.expanduser("~"), "Library", "Caches")
        else:
            base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    path = os.path.join(base, "pixelmaps")
    os.makedirs(path, exist_ok=True)
    return path


def load_region(lat, lon, z=13, grid=5):
    """Karte der Stadt aus OSM-Kacheln (gecacht), damit der Zoom echte
    Strassen zeigt statt einer hochskalierten Weltkarte."""
    # Eine Stadt-Karte ist ~1,7 MB, die gehoert nicht ins Repo (pro Sprache
    # eine Stadt).
    cache_dir = os.path.join(cache_root(), "regions")
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, f"region_{z}_{lat:.2f}_{lon:.2f}.png")
    if os.path.exists(path):
        return Image.open(path).convert("RGB")
    xt, yt = deg2num(lat, lon, z)
    x0, y0 = int(xt) - grid // 2, int(yt) - grid // 2
    tdir = os.path.join(cache_root(), "tiles")
    os.makedirs(tdir, exist_ok=True)
    big = Image.new("RGB", (grid * 256, grid * 256))
    for gx in range(grid):
        for gy in range(grid):
            p = os.path.join(tdir, f"z{z}_{x0 + gx}_{y0 + gy}.png")
            if not os.path.exists(p):
                url = f"https://tile.openstreetmap.org/{z}/{x0 + gx}/{y0 + gy}.png"
                req = urllib.request.Request(url, headers={"User-Agent": "pixelmaps-clipbuilder/1.0"})
                with urllib.request.urlopen(req, timeout=60) as r, open(p, "wb") as f:
                    f.write(r.read())
            big.paste(Image.open(p).convert("RGB"), (gx * 256, gy * 256))
    big = nightify(big, sat=0.36, bright=0.38, contrast=1.4, tint=0.26)
    big.save(path)
    return big


WORLD = nightify(cm.load_world_map(), sat=0.55, bright=0.6, contrast=1.75, tint=0.22)
WX, WY = cm.ll_from_latlon(TARGET["lat"], TARGET["lon"], size=WORLD.width, ins=26)
REGION, RX, RY = None, 0.0, 0.0


def region_point(lat, lon, z=13, grid=5):
    xt, yt = deg2num(lat, lon, z)
    return (xt - (int(xt) - grid // 2)) * 256, (yt - (int(yt) - grid // 2)) * 256


def configure(hook="", sub="", lang="de", city="", lat=None, lon=None, address=""):
    global HOOK, SUB, LANG, TARGET, ADDRESS, REGION, RX, RY, WX, WY, FONT_CURRENT
    LANG = lang if lang in L else "de"
    FONT_CURRENT = SCRIPT_FONT.get(LANG, (FONT_LATIN, 1))
    T = L[LANG]
    HOOK = (hook or T["hook"]).strip()
    SUB = (sub or T["sub"]).strip()
    if city or lat or lon:
        TARGET = {"city": (city or TARGET["city"]).upper(),
                  "lat": lat if lat else TARGET["lat"],
                  "lon": lon if lon else TARGET["lon"]}
    elif LANG in CITIES:
        # Ohne eigene Stadt: die Stadt, die zur Sprache passt.
        c = CITIES[LANG]
        TARGET = {"city": c[0], "lat": c[1], "lon": c[2]}
        if not address:
            address = c[3]
    WX, WY = cm.ll_from_latlon(TARGET["lat"], TARGET["lon"], size=WORLD.width, ins=26)
    if address:
        ADDRESS = address
    elif city:
        ADDRESS = city
    REGION = load_region(TARGET["lat"], TARGET["lon"])
    RX, RY = region_point(TARGET["lat"], TARGET["lon"])


configure()


def crop_center(img, cx, cy, cw, ch):
    cw, ch = min(cw, img.width), min(ch, img.height)
    x0 = max(0, min(img.width - cw, cx - cw / 2))
    y0 = max(0, min(img.height - ch, cy - ch / 2))
    return img.crop((int(x0), int(y0), int(x0 + cw), int(y0 + ch)))


def backdrop(img):
    """Weichgezeichneter Hintergrund, damit oben/unten kein schwarzes Loch klafft."""
    small = img.resize((W // 4, int(W // 4 * img.height / img.width)), Image.BILINEAR)
    scale = max(W / small.width, H / small.height)
    small = small.resize((int(small.width * scale), int(small.height * scale)), Image.BILINEAR)
    x0 = (small.width - W) // 2
    y0 = (small.height - H) // 2
    small = small.crop((x0, y0, x0 + W, y0 + H)).filter(ImageFilter.GaussianBlur(26))
    return ImageEnhance.Brightness(small).enhance(0.6)


def vignette():
    v = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(v)
    d.ellipse([-W * 0.45, -H * 0.25, W * 1.45, H * 1.25], fill=255)
    v = v.filter(ImageFilter.GaussianBlur(140))
    dark = Image.new("RGBA", (W, H), (2, 4, 9, 255))
    dark.putalpha(v.point(lambda p: int(255 * (1 - p / 255) * 0.85)))
    return dark


VIG = vignette()
_tiles_glow = {}


def glow(size, color=TEAL, strength=1.0):
    key = (size, color, strength)
    if key in _tiles_glow:
        return _tiles_glow[key]
    g = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(g)
    for i in range(16, 0, -1):
        r = size / 2 * i / 16
        a = int(11 * strength * (1 - i / 16) ** 1.5)
        d.ellipse([size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r],
                  fill=tuple(color) + (a,))
    g = g.filter(ImageFilter.GaussianBlur(size * 0.05))
    _tiles_glow[key] = g
    return g


GLOW = glow(700)
GLOW_BIG = glow(1100, strength=0.75)


def draw_pin(frame, t, px=W // 2, py=980):
    if t < 2.55:
        return
    dt = t - 2.55
    for delay in (0.0, 0.18):
        p = (dt - delay) / 0.6
        if 0 < p < 1:
            r = 24 + 300 * ease(p)
            ring = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            ImageDraw.Draw(ring).ellipse([px - r, py - r, px + r, py + r],
                                         outline=TEAL + (int(200 * (1 - p)),), width=6)
            comp(frame, ring)
    g = GLOW if dt < 0.7 else GLOW_BIG
    comp(frame, g, (px - g.width / 2, py - g.height / 2))
    s = 22 + 32 * (1 - math.exp(-dt * 10))
    d = ImageDraw.Draw(frame)
    d.rounded_rectangle([px - s, py - s, px + s, py + s], radius=9,
                        fill=TEAL + (255,), outline=(240, 255, 252, 255), width=3)
    if dt < 0.10:
        comp(frame, Image.new("RGBA", (W, H), (255, 255, 255, int(80 * (1 - dt / 0.10)))))


# ────────────────────────────── Szenen ──────────────────────────────
def scene_world(t):
    frame = Image.new("RGBA", (W, H), NAVY + (255,))
    u = ease((t - 0.05) / 1.0)
    cw = lerp(WORLD.width, WORLD.width * 0.62, u)
    sq = crop_center(WORLD, WX, WY, cw, cw).resize((W, W), Image.LANCZOS)
    if cw < WORLD.width * 0.9:
        sq = sq.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=2))
    comp(frame, backdrop(crop_center(WORLD, WX, WY, cw * 1.4, cw * 1.4)), (0, 0))
    y = int(lerp(330, 420, u))
    comp(frame, sq, (0, y))
    d = ImageDraw.Draw(frame)
    d.rectangle([0, y, W - 1, y + W], outline=(26, 190, 160, 55), width=2)
    return frame


def scene_search(t):
    frame = Image.new("RGBA", (W, H), NAVY + (255,))
    bg = crop_center(REGION, RX, RY, 700, 1244).resize((W, H), Image.LANCZOS)
    bg = ImageEnhance.Brightness(bg).enhance(0.62).filter(ImageFilter.GaussianBlur(7))
    comp(frame, bg, (0, 0))

    a = ease((t - 1.02) / 0.18)
    bx0, bx1 = 76, W - 76
    by0, by1 = 870, 1010
    box = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    db = ImageDraw.Draw(box)
    db.rounded_rectangle([bx0, by0, bx1, by1], radius=70, fill=(9, 17, 30, 246),
                         outline=TEAL_DIM + (int(200 * a),), width=3)
    # Lupe
    cx, cy, r = bx0 + 74, (by0 + by1) // 2, 23
    db.ellipse([cx - r, cy - r, cx + r, cy + r], outline=MUTED + (int(235 * a),), width=5)
    db.line([cx + r - 4, cy + r - 4, cx + r + 16, cy + r + 16], fill=MUTED + (int(235 * a),), width=5)

    typed_n = max(0, int((t - 1.16) * 24))
    typed = ADDRESS[:min(len(ADDRESS), typed_n)]
    done = typed_n >= len(ADDRESS)
    f = F(50, False)
    if typed:
        db.text((bx0 + 126, (by0 + by1) // 2 - 31), typed, font=f, fill=(238, 248, 252, 255))
        if not done and int(t * 2.6) % 2 == 0:
            tw = db.textlength(typed, font=f)
            db.rectangle([bx0 + 131 + tw, by0 + 42, bx0 + 136 + tw, by1 - 42], fill=TEAL + (235,))
    comp(frame, box, (0, 0))
    if done:
        a2 = ease((t - 1.86) / 0.16)
        line(frame, L[LANG]["found"].format(city=TARGET["city"].capitalize()),
             46, 1080, TEAL, a2, max_w=760)
    return frame


def scene_map(t):
    frame = Image.new("RGBA", (W, H), NAVY + (255,))
    u = ease((t - 2.10) / 0.95)
    cw = lerp(REGION.width * 0.95, 640, u)
    # danach langsam weiter aufziehen, damit das Bild nie steht
    cw = lerp(cw, 430, ease((t - 3.10) / 6.3))
    ch = cw * H / W
    img = crop_center(REGION, RX, RY, cw, ch).resize((W, H), Image.LANCZOS)
    comp(frame, img, (0, 0))
    draw_pin(frame, t)
    a = ease((t - 2.58) / 0.25)
    dec = L[LANG]["dec"]
    lat = f"{abs(TARGET['lat']):.2f}".replace(".", dec)
    lon = f"{abs(TARGET['lon']):.2f}".replace(".", dec)
    ns = DIRS[LANG][0][0 if TARGET["lat"] >= 0 else 1]
    ew = DIRS[LANG][1][0 if TARGET["lon"] >= 0 else 1]
    line(frame, L[LANG]["coords"].format(city=TARGET["city"], lat=lat, lon=lon, ns=ns, ew=ew),
         38, 1120, (176, 245, 228), a, bold=False, max_w=920)
    return frame


def scene(t):
    if t < 1.02:
        frame = scene_world(t)
    elif t < 2.10:
        frame = scene_search(t)
    else:
        frame = scene_map(t)

    # Scrim oben fuer Textkontrast
    scrim = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ds = ImageDraw.Draw(scrim)
    for i in range(1100):
        a = int(126 * max(0.0, 1 - i / 1100) ** 1.3)
        ds.line([(0, i), (W, i)], fill=(3, 6, 12, a))
    comp(frame, scrim)

    # ── Hook ────────────────────────────────────────────────────
    a_hook = 1.0 if t < 2.30 else max(0.0, 1 - (t - 2.30) / 0.30)
    if t < 2.10 and a_hook > 0:
        k = ease((t - 0.55) / 0.9)
        size = int(lerp(132, 62, k) * (1.06 - 0.06 * ease(t / 0.25)))
        cy = lerp(650, 292, k)
        bottom = draw_hook(frame, cy, size, a_hook, max_w=880)
        ss = int(lerp(54, 34, k))
        line(frame, SUB, ss, bottom + ss * 0.30 + ss * 0.55,
             TEAL, ease((t - 0.28) / 0.3) * a_hook, max_w=900)

    # ── Preis ───────────────────────────────────────────────────
    a_b = win(t, 3.15, 5.20, 0.26)
    if a_b > 0:
        line(frame, L[LANG]["price_top"], 190, 520, WHITE, a_b,
             grad=(TEAL, (225, 255, 248)), max_w=700)
        line(frame, L[LANG]["pay"], 52, 690, WHITE, a_b, max_w=940)
        line(frame, L[LANG]["details"], 46, 768, MUTED, a_b, bold=False, max_w=940)

    # ── Ehrliche Zahl ───────────────────────────────────────────
    a_c = win(t, 5.20, 7.40, 0.28)
    if a_c > 0:
        line(frame, L[LANG]["today"], 28, 430, TEAL_DIM, a_c, max_w=800, tracking=8)
        line(frame, L[LANG]["ofbillion"].format(n=SELLING), 92, 530, WHITE, a_c,
             grad=((255, 255, 255), TEAL), max_w=940)
        pct = f"{SELLING / TOTAL * 100:.7f}".replace(".", L[LANG]["dec"])
        line(frame, L[LANG]["share"].format(pct=pct), 46, 640, MUTED, a_c,
             bold=False, max_w=900)
        bx0, bx1, by = 150, 930, 700
        bar = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        db = ImageDraw.Draw(bar)
        db.rounded_rectangle([bx0, by, bx1, by + 10], radius=5, fill=(32, 46, 64, 255))
        db.rounded_rectangle([bx0, by, bx0 + 6, by + 10], radius=5, fill=TEAL + (255,))
        comp(frame, bar.crop((0, by - 20, W, by + 40)), (0, by - 20))

    # ── CTA ─────────────────────────────────────────────────────
    a_d = win(t, 7.40, 9.35, 0.26)
    if a_d > 0:
        line(frame, L[LANG]["cta_top"], 48, 462, MUTED, a_d, bold=False, max_w=900)
        line(frame, "pixelmaps.org", 104, 590, WHITE, a_d, grad=(TEAL, (235, 255, 250)), max_w=960)
        line(frame, L[LANG]["cta_foot"], 40, 700, WHITE, a_d, bold=False, max_w=900)

    # ── Loop zurück zum Hook ────────────────────────────────────
    a_e = ease((t - 9.35) / 0.45)
    if a_e > 0:
        fade = Image.new("RGBA", (W, H), NAVY + (int(252 * a_e),))
        comp(frame, fade)
        bottom = draw_hook(frame, 660, 132, a_e, max_w=880)
        line(frame, SUB, 54, bottom + 54 * 0.30 + 54 * 0.55, TEAL, a_e, max_w=900)

    line(frame, "PIXELMAPS.ORG", 24, 118, TEAL_DIM, 0.8, max_w=600, tracking=9)
    comp(frame, VIG)
    return frame


# ────────────────────────────── Audio ──────────────────────────────
def audio(dur, out_wav):
    bed = cm.synth_music(dur + 0.5, "drive")
    with wave.open(bed) as w:
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768.0
        ch = w.getnchannels()
    raw = raw.reshape(-1, ch)
    n = len(raw)
    sig = raw.copy()

    def add(start, s, gain=1.0):
        i = int(start * SR)
        j = min(n, i + len(s))
        if i < n and j > i:
            sig[i:j] += (s[: j - i] * gain)[:, None]

    rng = np.random.default_rng(11)
    # Whooshes an den Schnitten
    for st in (0.92, 2.02):
        nl = int(0.42 * SR)
        tt = np.arange(nl) / SR
        noise = rng.normal(0, 1, nl)
        noise = np.convolve(noise, np.array([1, -0.9]), mode="same")
        env = np.sin(np.pi * tt / 0.42) ** 2
        add(st, noise * env, 0.13)
    # Tippgeraeusche
    for k in range(18):
        st = 1.16 + k * (len(ADDRESS) / 26.0) / 18
        nl = int(0.05 * SR)
        tt = np.arange(nl) / SR
        add(st, np.sin(2 * np.pi * 2100 * tt) * np.exp(-tt * 90), 0.05)
    # Einschlag
    nl = int(1.3 * SR)
    tt = np.arange(nl) / SR
    ping = (np.sin(2 * np.pi * 660 * tt) * 0.5 + np.sin(2 * np.pi * 990 * tt) * 0.3
            + np.sin(2 * np.pi * 1320 * tt) * 0.16) * np.exp(-tt * 7.0)
    add(2.55, ping, 0.5)
    # Szenenwechsel
    for st in (3.30, 5.20, 7.40):
        nl = int(0.18 * SR)
        tt = np.arange(nl) / SR
        add(st, np.sin(2 * np.pi * 1180 * tt) * np.exp(-tt * 45), 0.16)

    mx = np.max(np.abs(sig)) or 1.0
    sig = sig / mx * 0.88
    with wave.open(out_wav, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((sig * 32767).astype(np.int16).tobytes())
    return out_wav


# ────────────────────────────── Rendern ──────────────────────────────
def render(out, stills=None, cover=""):
    ff = os.environ.get("FFMPEG") or "ffmpeg"
    if stills:
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        for s in stills:
            scene(s).convert("RGB").save(out.replace(".mp4", f"-{s:.2f}s.png"))
            print("still", s)
        return
    tmp = tempfile.mkdtemp(prefix="short")
    try:
        fd = os.path.join(tmp, "f")
        os.makedirs(fd)
        frames = int(DUR * FPS)
        for i in range(frames):
            scene(i / FPS).convert("RGB").save(os.path.join(fd, f"f{i:04d}.png"))
            if i % 75 == 0:
                print(f"  {i}/{frames}")
        silent = os.path.join(tmp, "silent.mp4")
        subprocess.run([ff, "-y", "-framerate", str(FPS), "-i", os.path.join(fd, "f%04d.png"),
                        "-c:v", "libx264", "-preset", "medium", "-crf", "24",
                        "-pix_fmt", "yuv420p", silent], check=True, capture_output=True)
        wav = audio(DUR, os.path.join(tmp, "mix.wav"))
        ad = os.path.join(tmp, "mix.m4a")
        subprocess.run([ff, "-y", "-i", wav,
                        "-af", "loudnorm=I=-15:TP=-1.5:LRA=11,aresample=48000",
                        "-ac", "2", "-c:a", "aac", "-b:a", "160k", ad],
                       check=True, capture_output=True)
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        subprocess.run([ff, "-y", "-i", silent, "-i", ad,
                        "-af", f"afade=t=out:st={DUR - 0.45}:d=0.45",
                        "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart",
                        "-shortest", out], check=True, capture_output=True)
        print("Fertig: " + out)
        if cover:
            os.makedirs(os.path.dirname(cover) or ".", exist_ok=True)
            scene(0.45).convert("RGB").save(cover, quality=92)
            print("Cover: " + cover)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/clips/examples/short-de.mp4")
    ap.add_argument("--hook", default="", help="Headline im Video (z. B. der Post-Hook)")
    ap.add_argument("--sub", default="", help="zweite Zeile")
    ap.add_argument("--lang", default="de", choices=list(L.keys()))
    ap.add_argument("--city", default="")
    ap.add_argument("--lat", type=float, default=0.0)
    ap.add_argument("--lon", type=float, default=0.0)
    ap.add_argument("--address", default="")
    ap.add_argument("--cover", default="", help="zusaetzlich Titelbild als JPG speichern")
    ap.add_argument("--stills", default="")
    a = ap.parse_args()
    configure(hook=a.hook, sub=a.sub, lang=a.lang, city=a.city,
              lat=a.lat or None, lon=a.lon or None, address=a.address)
    st = [float(x) for x in a.stills.split(",") if x.strip()] if a.stills else None
    render(a.out, st, a.cover)
