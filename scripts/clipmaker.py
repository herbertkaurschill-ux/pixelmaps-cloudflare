#!/usr/bin/env python3
"""
clipmaker.py – baut aus einem täglichen KI-Bild einen vertikalen Kurzclip
mit Ken-Burns-Zoom, Text-Overlay und deutscher Sprachausgabe (edge-tts).

Nutzung:
  python3 clipmaker.py --prompt "HOOK" --title "TIEL" \
    --out public/clips/generated/2026-09-21-YouTubeShorts.mp4 \
    [--duration 6] [--voice de-DE-KatjaNeural] [--style "..." ]
"""
import argparse, json, os, subprocess, sys, tempfile, urllib.request, shutil

W = 1080
H = 1920
FPS = 30
default_style = "vertical pixel-art world map, glowing teal neon on dark navy, cinematic"
PIPER_MODEL = os.path.expanduser("~/.n8n/agent/voices/de_DE-thorsten-high.onnx")
PIPER_CONFIG = PIPER_MODEL + ".json"

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/SFNS.ttf",
]

def font(size):
    from PIL import ImageFont
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    raise RuntimeError("Keine passende Schrift gefunden")


def fetch_image(prompt, dest):
    url = ("https://image.pollinations.ai/prompt/" +
           urllib.request.quote(prompt, safe="") +
           "?width=1080&height=1920&nologo=true")
    req = urllib.request.Request(url, headers={"User-Agent": "pixelmaps-clipbuilder/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def wrap_text(draw, text, font, max_w):
    words, lines, line = text.split(), [], ""
    for w in words:
        test = (line + " " + w).strip()
        if draw.textlength(test, font=font) <= max_w:
            line = test
        else:
            if line: lines.append(line)
            line = w
    if line: lines.append(line)
    return lines


def fit_font(draw, text, max_w, start=96, minimum=46):
    import PIL.ImageFont as IF
    size = start
    while size >= minimum:
        f = IF.truetype(FONT_CANDIDATES[0] if os.path.exists(FONT_CANDIDATES[0]) else FONT_CANDIDATES[1], size)
        lines = wrap_text(draw, text, f, max_w)
        if len(lines) <= 2 and all(draw.textlength(l, font=f) <= max_w for l in lines):
            return f, lines
        size -= 4
    f = IF.truetype(FONT_CANDIDATES[0] if os.path.exists(FONT_CANDIDATES[0]) else FONT_CANDIDATES[1], minimum)
    return f, wrap_text(draw, text, f, max_w)


def render_overlay(base, title, subtitle, out_path):
    from PIL import Image, ImageDraw
    img = Image.open(base).convert("RGB")
    ratio = W / H
    iw, ih = img.size
    ir = iw / ih
    if ir > ratio:
        nw = int(ih * ratio); nx = (iw - nw) // 2
        img = img.crop((nx, 0, nx + nw, ih))
    else:
        nh = int(iw / ratio); ny = (ih - nh) // 2
        img = img.crop((0, ny, iw, ny + nh))
    img = img.resize((W, H), Image.LANCZOS)
    canvas = img.convert("RGBA")
    d = ImageDraw.Draw(canvas)

    # Dunkler Fussbereich fuer besseren Textkontrast
    for i in range(H - 760, H):
        a = int(215 * (i - (H - 760)) / 760)
        d.rectangle([0, i, W, i], fill=(8, 12, 26, a))

    # Top-Badge "PIXELMAPS.ORG"
    f_badge = font(38)
    badge_txt = "PIXELMAPS.ORG"
    bw = d.textlength(badge_txt, font=f_badge) + 56
    d.rounded_rectangle([36, 42, 36 + bw, 118], radius=38, fill=(8, 20, 38, 210), outline=(120, 220, 255, 230), width=2)
    d.text((68, 56), badge_txt, font=f_badge, fill=(150, 230, 255, 255))

    # Titel: center, max. 2 Zeilen, automatisch verkleinert
    f_title, lines = fit_font(d, title, 940)
    line_h = 104
    total = len(lines) * line_h
    ty = H - 640 + (line_h * 2 - total) // 2
    for li in lines:
        tw = d.textlength(li, font=f_title)
        d.text(((W - tw) / 2, ty), li, font=f_title, fill=(255, 255, 255, 255))
        ty += line_h

    # Subtitle (Hook-Zitat), 1 Zeile
    if subtitle:
        f_sub = font(44)
        while subtitle and d.textlength(subtitle, font=f_sub) > 940:
            subtitle = subtitle[:-1]
        sw = d.textlength(subtitle, font=f_sub)
        d.text(((W - sw) / 2, H - 300), subtitle, font=f_sub, fill=(205, 220, 235, 255))

    # CTA-Button
    f_cta = font(52)
    cta_txt = "pixelmaps.org"
    cw = d.textlength(cta_txt, font=f_cta) + 64
    btn_y = H - 210
    d.rounded_rectangle([(W - cw) / 2, btn_y, (W + cw) / 2, btn_y + 92], radius=46, fill=(0, 180, 210, 235))
    d.text(((W - d.textlength(cta_txt, font=f_cta)) / 2, btn_y + 14), cta_txt, font=f_cta, fill=(8, 14, 28, 255))

    canvas.convert("RGB").save(out_path, "PNG")


def ken_burns_frames(overlay, out_dir, seconds):
    from PIL import Image
    img = Image.open(overlay).convert("RGB")
    frames = seconds * FPS
    for i in range(frames):
        p = i / max(frames - 1, 1)
        zoom = 1.22 - 0.18 * p
        cw, ch = int(W / zoom), int(H / zoom)
        cx = int(W / 2 - cw / 2 + int(46 * p))
        cy = int(H / 2 - ch / 2 - int(20 * p))
        fr = img.crop((cx, cy, cx + cw, cy + ch)).resize((W, H), Image.LANCZOS)
        fr.save(os.path.join(out_dir, f"f{i:04d}.png"))


def tts(text, dest):
    import sys
    spoken = " ".join(text.split())[:90]
    code = (
        "import sys, wave; "
        "from piper.voice import PiperVoice; "
        f"v = PiperVoice.load({PIPER_MODEL!r}, config_path={PIPER_CONFIG!r}); "
        f"w = wave.open({dest!r}, 'wb'); "
        "v.synthesize_wav(sys.argv[1], w); w.close()"
    )
    subprocess.run([sys.executable, "-c", code, spoken], check=True, capture_output=True)


def build(prompt, title, subtitle, out, seconds):
    tmp = tempfile.mkdtemp(prefix="clipmaker")
    try:
        base = os.path.join(tmp, "base.jpg")
        print("[1/4] KI-Bild laden ...")
        fetch_image(prompt, base)
        print("[2/4] Overlay rendern ...")
        ov = os.path.join(tmp, "overlay.png")
        render_overlay(base, title, subtitle, ov)
        print("[3/4] Ken-Burns-Frames ...")
        fd = os.path.join(tmp, "frames")
        os.makedirs(fd)
        ken_burns_frames(ov, fd, seconds)
        audio = os.path.join(tmp, "voice.mp3")
        try:
            tts(prompt, audio)
        except Exception as e:
            print("  TTS fehlgeschlagen, ohne Stimme weiter:", e)
            audio = None
        print("[4/4] Video zusammensetzen ...")
        silent = os.path.join(tmp, "silent.mp4")
        subprocess.run(
            ["ffmpeg", "-y", "-framerate", str(FPS), "-i", os.path.join(fd, "f%04d.png"),
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", silent],
            check=True, capture_output=True)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        if audio and os.path.exists(audio):
            ad = os.path.join(tmp, "padded.m4a")
            subprocess.run(
                ["ffmpeg", "-y", "-i", audio,
                 "-af", "adelay=250|250,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000",
                 "-ac", "2", "-c:a", "aac", "-b:a", "160k", ad],
                check=True, capture_output=True)
            subprocess.run(
                ["ffmpeg", "-y", "-i", silent, "-i", ad,
                 "-c:v", "copy", "-c:a", "copy", "-shortest", out],
                check=True, capture_output=True)
        else:
            shutil.copyfile(silent, out)
        print("OK: " + out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--subtitle", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--duration", type=int, default=6)
    ap.add_argument("--style", default=default_style)
    a = ap.parse_args()
    build(a.style + ", " + a.prompt, a.title, a.subtitle, a.out, a.duration)


if __name__ == "__main__":
    main()