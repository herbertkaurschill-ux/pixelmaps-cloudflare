// Gemeinsamer Clip-Index fuer die Buffer-Planung.
// Waehlt ausschliesslich Clips aus, die wirklich als Datei in
// public/clips/campaign liegen (und damit auch live erreichbar sind).
// Frueher zeigten die Planer auf /clips/generated/<tag>-<plattform>.mp4 —
// diese Dateien existieren nur bis zum 05.10.2026, alle geplanten Posts
// hatten damit tote Video-URLs und sind beim Publizieren gescheitert.
const fs = require("fs");
const path = require("path");

const LANGS = ["de", "en", "es", "fr", "it", "pt", "tr", "ru", "hi", "zh"];
const HERE = __dirname;
const CAMPAIGN_DIR = path.join(HERE, "..", "..", "public", "clips", "campaign");
const VIDEOS_JSON = path.join(HERE, "videos.json");
const BASE = "https://pixelmaps.org/clips/campaign";

// Sprache aus dem Clip-Namen ableiten:
//   c1-proof-de      -> de      c1-proof-en-own -> en
//   v01-en-what-if-billion -> en v08-germany-full -> de (Default)
function langOf(id) {
  const parts = String(id).split("-");
  for (let i = parts.length - 1; i >= 1; i--) {
    if (LANGS.includes(parts[i])) return parts[i];
  }
  return "de";
}

function titles() {
  try {
    const v = JSON.parse(fs.readFileSync(VIDEOS_JSON, "utf8"));
    const m = {};
    for (const x of v) if (x && x.id) m[x.id] = x.title || x.id;
    return m;
  } catch (_) { return {}; }
}

// Alle lokal vorhandenen Campaign-Clips, nach Sprache gruppiert.
function loadClipIndex() {
  const T = titles();
  const byLang = {};
  const all = [];
  let files = [];
  try { files = fs.readdirSync(CAMPAIGN_DIR); } catch (_) { files = []; }
  for (const f of files) {
    if (!f.endsWith(".mp4")) continue;
    const id = f.slice(0, -4);
    const lang = langOf(id);
    const title = T[id] || T[id.replace("-en-", "-")] || id;
    const clip = { id, lang, title, url: `${BASE}/${id}.mp4` };
    all.push(clip);
    (byLang[lang] = byLang[lang] || []).push(clip);
  }
  for (const l of Object.keys(byLang)) byLang[l].sort((a, b) => a.id.localeCompare(b.id));
  return { all, byLang, byId: Object.fromEntries(all.map((c) => [c.id, c])) };
}

// Clip fuer eine Sprache waehlen. seed sorgt fuer Streuung, usedClips
// verhindert, dass derselbe Clip zweimal in einer Woche laeuft.
function pickClip(index, lang, seed, usedClips) {
  const pool = (index.byLang[lang] && index.byLang[lang].length ? index.byLang[lang] : index.all);
  if (!pool.length) return null;
  const free = pool.filter((c) => !usedClips || !usedClips.has(c.id));
  const use = free.length ? free : pool;
  return use[Math.abs(seed) % use.length];
}

module.exports = { LANGS, langOf, loadClipIndex, pickClip, BASE };
