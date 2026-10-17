#!/usr/bin/env node
// Ergänzt statische Seiten um Canonical, robots, OG/Twitter und hreflang.
// Idempotent: bereits vorhandene Tags werden ersetzt, nicht dupliziert.
//
//   node scripts/seo-meta.mjs            # Schreiben
//   node scripts/seo-meta.mjs --check    # nur pruefen (CI-faehig)

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://pixelmaps.org";
const CHECK = process.argv.includes("--check");

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Reihenfolge im Dokument = Reihenfolge im Block, damit nichts doppelt laeuft.
const CONTENT = {
  "ueber": {
    lang: "de",
    title: "Über & FAQ · PixelMaps",
    desc: "Alles zu PixelMaps: Wie die Weltkarte aus einer Milliarde Pixeln funktioniert, was ein Zertifikat ist und wie du deinen eigenen Pixel sicherst.",
    ogTitle: "Über PixelMaps & FAQ",
    ogDesc: "Wie die Weltkarte aus einer Milliarde Pixeln funktioniert und wie du deinen eigenen Pixel sicherst.",
    robots: "index, follow, max-image-preview:large",
    alts: ["/ueber", "/en/about", "/hi/about"]
  },
  "impressum": {
    lang: "de",
    title: "Impressum · PixelMaps",
    desc: "Anbieterkennzeichnung und Kontaktdaten von PixelMaps gemäß § 5 DDG.",
    ogTitle: "Impressum · PixelMaps",
    ogDesc: "Anbieterkennzeichnung und Kontaktdaten von PixelMaps.",
    robots: "index, follow",
    alts: ["/impressum", "/en/impressum", "/hi/impressum"]
  },
  "datenschutz": {
    lang: "de",
    title: "Datenschutzerklärung · PixelMaps",
    desc: "Wie PixelMaps personenbezogene Daten verarbeitet, welche Daten beim Kauf anfallen und welche Rechte du hast.",
    ogTitle: "Datenschutzerklärung · PixelMaps",
    ogDesc: "Wie PixelMaps personenbezogene Daten verarbeitet und welche Rechte du hast.",
    robots: "index, follow",
    alts: ["/datenschutz", "/en/privacy", "/hi/privacy"]
  },
  "agb": {
    lang: "de",
    title: "AGB · PixelMaps",
    desc: "Nutzungsbedingungen für den Kauf geografischer Pixel auf der PixelMaps-Weltkarte.",
    ogTitle: "AGB · PixelMaps",
    ogDesc: "Nutzungsbedingungen für den Kauf geografischer Pixel auf der PixelMaps-Weltkarte.",
    robots: "index, follow",
    alts: ["/agb", "/en/terms", "/hi/terms"]
  },
  "en/about": {
    lang: "en",
    title: "About & FAQ · PixelMaps",
    desc: "How PixelMaps works: a world map made of one billion pixels, what your certificate is worth, and how to secure your own pixel.",
    ogTitle: "About PixelMaps & FAQ",
    ogDesc: "A world map made of one billion pixels — and how to secure your own.",
    robots: "index, follow, max-image-preview:large",
    alts: ["/ueber", "/en/about", "/hi/about"]
  },
  "en/impressum": {
    lang: "en",
    title: "Imprint · PixelMaps",
    desc: "Provider identification and contact details for PixelMaps.",
    ogTitle: "Imprint · PixelMaps",
    ogDesc: "Provider identification and contact details for PixelMaps.",
    robots: "index, follow",
    alts: ["/impressum", "/en/impressum", "/hi/impressum"]
  },
  "en/privacy": {
    lang: "en",
    title: "Privacy Policy · PixelMaps",
    desc: "How PixelMaps processes personal data, what is collected during a purchase, and what rights you have.",
    ogTitle: "Privacy Policy · PixelMaps",
    ogDesc: "What data PixelMaps collects and what rights you have.",
    robots: "index, follow",
    alts: ["/datenschutz", "/en/privacy", "/hi/privacy"]
  },
  "en/terms": {
    lang: "en",
    title: "Terms & Conditions · PixelMaps",
    desc: "Terms of use for buying geographic pixels on the PixelMaps world map.",
    ogTitle: "Terms & Conditions · PixelMaps",
    ogDesc: "Terms of use for buying geographic pixels on the PixelMaps world map.",
    robots: "index, follow",
    alts: ["/agb", "/en/terms", "/hi/terms"]
  },
  "hi/about": {
    lang: "hi",
    title: "परिचय एवं FAQ · PixelMaps",
    desc: "PixelMaps कैसे काम करता है: एक अरब पिक्सेल वाला विश्व मानचित्र, आपका प्रमाणपत्र और अपना पिक्सेल कैसे सुरक्षित करें।",
    ogTitle: "PixelMaps के बारे में और FAQ",
    ogDesc: "एक अरब पिक्सेल वाला विश्व मानचित्र — और अपना पिक्सेल कैसे सुरक्षित करें।",
    robots: "index, follow, max-image-preview:large",
    alts: ["/ueber", "/en/about", "/hi/about"]
  },
  "hi/impressum": {
    lang: "hi",
    title: "छाप · PixelMaps",
    desc: "PixelMaps के प्रदाता की जानकारी और संपर्क विवरण।",
    ogTitle: "छाप · PixelMaps",
    ogDesc: "PixelMaps के प्रदाता की जानकारी और संपर्क विवरण।",
    robots: "index, follow",
    alts: ["/impressum", "/en/impressum", "/hi/impressum"]
  },
  "hi/privacy": {
    lang: "hi",
    title: "गोपनीयता नीति · PixelMaps",
    desc: "PixelMaps व्यक्तिगत डेटा को कैसे संसाधित करता है, खरीद पर कौन-सा डेटा जमा होता है और आपके क्या अधिकार हैं।",
    ogTitle: "गोपनीयता नीति · PixelMaps",
    ogDesc: "PixelMaps कौन-सा डेटा जमा करता है और आपके क्या अधिकार हैं।",
    robots: "index, follow",
    alts: ["/datenschutz", "/en/privacy", "/hi/privacy"]
  },
  "hi/terms": {
    lang: "hi",
    title: "नियम एवं शर्तें · PixelMaps",
    desc: "PixelMaps विश्व मानचित्र पर भौगोलिक पिक्सेल खरीदने की नियम एवं शर्तें।",
    ogTitle: "नियम एवं शर्तें · PixelMaps",
    ogDesc: "PixelMaps विश्व मानचित्र पर भौगोलिक पिक्सेल खरीदने की शर्तें।",
    robots: "index, follow",
    alts: ["/agb", "/en/terms", "/hi/terms"]
  }
};

const HREFLANG = { "/ueber": "de", "/en/about": "en", "/hi/about": "hi" };

// Entfernt einen Tag-Block, damit wir ihn danach genau einmal einfuegen koennen.
function dropTag(html, re) {
  return html.replace(re, "").replace(/\n{3,}/g, "\n\n");
}

function buildTags(c) {
  const lines = [];
  lines.push(`  <link rel="canonical" href="${BASE}${c.canonical}">`);
  lines.push(`  <meta name="robots" content="${c.robots}">`);
  for (const a of c.alts) {
    const hl = HREFLANG[a] || "x-default";
    lines.push(`  <link rel="alternate" hreflang="${hl}" href="${BASE}${a}">`);
  }
  lines.push(`  <meta property="og:type" content="website">`);
  lines.push(`  <meta property="og:site_name" content="PixelMaps">`);
  lines.push(`  <meta property="og:locale" content="${c.ogLocale}">`);
  lines.push(`  <meta property="og:title" content="${esc(c.ogTitle)}">`);
  lines.push(`  <meta property="og:description" content="${esc(c.ogDesc)}">`);
  lines.push(`  <meta property="og:url" content="${BASE}${c.canonical}">`);
  lines.push(`  <meta property="og:image" content="${BASE}/og-image.png">`);
  lines.push(`  <meta property="og:image:width" content="1200">`);
  lines.push(`  <meta property="og:image:height" content="630">`);
  lines.push(`  <meta property="og:image:alt" content="${esc(c.ogDesc)}">`);
  lines.push(`  <meta name="twitter:card" content="summary_large_image">`);
  lines.push(`  <meta name="twitter:title" content="${esc(c.ogTitle)}">`);
  lines.push(`  <meta name="twitter:description" content="${esc(c.ogDesc)}">`);
  lines.push(`  <meta name="twitter:image" content="${BASE}/og-image.png">`);
  return lines.join("\n");
}

let changed = 0;
const problems = [];

for (const [key, meta] of Object.entries(CONTENT)) {
  const file = join(ROOT, "public", `${key}.html`);
  let html;
  try {
    html = readFileSync(file, "utf8");
  } catch {
    problems.push(`fehlt: public/${key}.html`);
    continue;
  }

  const lang = meta.lang;
  const canonical = "/" + key.replace(/^en\//, "").replace(/^hi\//, "");
  // /ueber bleibt /ueber, /en/about -> /about ist falsch -> eigene Tabelle.
  const CANON = {
    "ueber": "/ueber",
    "impressum": "/impressum",
    "datenschutz": "/datenschutz",
    "agb": "/agb",
    "en/about": "/ueber",
    "en/impressum": "/impressum",
    "en/privacy": "/datenschutz",
    "en/terms": "/agb",
    "hi/about": "/ueber",
    "hi/impressum": "/impressum",
    "hi/privacy": "/datenschutz",
    "hi/terms": "/agb"
  };
  const cfg = {
    ...meta,
    canonical: CANON[key],
    ogLocale: lang === "de" ? "de_DE" : lang === "en" ? "en_US" : "hi_IN"
  };

  const before = html;

  // Bestehende Tags entfernen
  html = dropTag(html, /^\s*<link rel="canonical"[^>]*>\n?/gm);
  html = dropTag(html, /^\s*<meta name="robots"[^>]*>\n?/gm);
  html = dropTag(html, /^\s*<link rel="alternate"[^>]*>\n?/gm);
  html = dropTag(html, /^\s*<meta property="og:[^>]*>\n?/gm);
  html = dropTag(html, /^\s*<meta name="twitter:[^>]*>\n?/gm);
  html = dropTag(html, /^\s*<meta name="description"[^>]*>\n?/gm);
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(cfg.title)}</title>`);
  html = html.replace(/<html lang="[^"]*"/, `<html lang="${lang}"`);

  const tags =
    `  <meta name="description" content="${esc(cfg.desc)}">\n` +
    buildTags(cfg) +
    `\n`;

  html = html.replace("</head>", tags + "</head>");

  if (html !== before) {
    changed++;
    if (CHECK) problems.push(`fehlt Meta: public/${key}.html`);
    else writeFileSync(file, html);
  } else if (CHECK) {
    problems.push(`unveraendert: public/${key}.html`);
  }
}

console.log(`${CHECK ? "geprueft" : "geschrieben"}: ${changed} Datei(en) veraendert, ${Object.keys(CONTENT).length} geprueft`);
if (CHECK && problems.length) {
  console.log(problems.join("\n"));
  process.exit(1);
}