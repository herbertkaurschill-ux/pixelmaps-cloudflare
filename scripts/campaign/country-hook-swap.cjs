#!/usr/bin/env node
// Ersetzt die erste Zeile bereits geplanter Buffer-Posts durch den Laender-Hook
// ("aus deinem Land gibt es noch keinen Pixel"). Die Sprache wird aus dem
// vorhandenen Hook-Text erkannt (die Rotation hat sich historisch verschoben,
// deshalb ist das Datum keine verlaessliche Quelle).
//
// Aufruf:  node scripts/campaign/country-hook-swap.cjs [--apply] [--from 2026-11-17] [--to 2026-11-23]
// Ohne --apply nur Vorschau. Originaltexte landen in .hookswap-backup.json.
const fs = require("fs");
const path = require("path");
const cfg = JSON.parse(fs.readFileSync(path.join(require("os").homedir(), ".n8n/agent/config.json"), "utf8"));
const H = { Authorization: "Bearer " + cfg.bufferAccessToken, "Content-Type": "application/json" };
const ORG = cfg.bufferOrgId || "6aafe8c03cf501260e7e406c";
const CH = cfg.bufferChannels || {};
const APPLY = process.argv.includes("--apply");
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const FROM = argOf("--from", "2026-11-17");
const TO = argOf("--to", "2026-11-23");

const { buildPost } = require("./post-text.cjs");
const LANGS = ["de", "en", "es", "fr", "it", "pt", "tr", "ru", "hi", "zh"];

// Erste Zeile, die wir setzen: der ehrliche "noch keiner aus deinem Land"-Satz.
const FIRST = {
  de: "Noch kein Pixel aus deinem Land? Dann mach den Anfang.",
  en: "No pixel from your country yet? Start it.",
  es: "¿Tu país aún no tiene píxel? Empieza tú.",
  fr: "Aucun pixel de ton pays ? Lance-le.",
  it: "Il tuo paese non ha ancora pixel? Inizia tu.",
  pt: "O teu país ainda não tem píxel? Começa tu.",
  tr: "Ülkenden henüz piksel yok mu? İlk adımı sen at.",
  ru: "Из твоей страны ещё нет пикселя? Начни.",
  hi: "तुम्हारे देश से अभी पिक्सल नहीं? शुरुआत तुम करो।",
  zh: "你的国家还没有像素？从你开始。"
};

// Alle bekannten Hook-Zeilen je Sprache -> sichere Spracherkennung.
const HOOKS = {};
for (const lang of LANGS) {
  HOOKS[lang] = new Set();
  for (const platform of ["TikTok", "Instagram", "YouTubeShorts"]) {
    for (let d = 1; d <= 28; d++) {
      const date = new Date(Date.UTC(2026, 9, d)).toISOString().slice(0, 10);
      try {
        const p = buildPost({ platform, lang, date, design: "neon" });
        HOOKS[lang].add(String(p.text || "").split("\n")[0].trim());
      } catch (_) {}
    }
  }
}
function langOfLine(line) {
  const l = String(line || "").trim();
  for (const lang of LANGS) if (HOOKS[lang].has(l)) return lang;
  return "";
}

const Q = `query($o:OrganizationId!,$f:PostsFiltersInput!){posts(input:{organizationId:$o,filter:$f,sort:[{field:dueAt,direction:asc}]}){edges{node{id channelId status dueAt text assets{type source}
 metadata{__typename
   ... on InstagramPostMetadata{type shouldShareToFeed firstComment link isAiGenerated}
   ... on YoutubePostMetadata{title privacy madeForKids notifySubscribers embeddable license isAiGenerated category{categoryId}}
 }}}}}`;
const EDIT = `mutation($i:EditPostInput!){ editPost(input:$i){ __typename } }`;

async function gql(query, variables) {
  const r = await fetch("https://api.buffer.com", { method: "POST", headers: H, body: JSON.stringify({ query, variables }) });
  return r.json();
}

(async () => {
  const now = Date.now();
  const start = Date.parse(FROM + "T00:00:00Z");
  const end = Date.parse(TO + "T23:59:59Z");
  const backupFile = path.join(__dirname, ".hookswap-backup.json");
  const backup = fs.existsSync(backupFile) ? JSON.parse(fs.readFileSync(backupFile, "utf8")) : {};
  let changed = 0, skipped = 0;

  for (const [platform, cid] of Object.entries(CH)) {
    if (!cid) continue;
    for (let t = Math.max(start, now); t < end; t += 4 * 864e5) {
      const f = { channelIds: [cid], status: ["scheduled"], dueAt: { start: new Date(t).toISOString(), end: new Date(Math.min(t + 4 * 864e5, end)).toISOString() } };
      const j = await gql(Q, { o: ORG, f });
      for (const e of ((j.data || {}).posts || {}).edges || []) {
        const n = e.node;
        const day = String(n.dueAt).slice(0, 10);
        if (day < FROM || day > TO) continue;
        const lines = String(n.text || "").split("\n");
        const lang = langOfLine(lines[0]);
        if (!lang) { skipped++; console.log("SKIP  " + platform + " " + day + " (Sprache unbekannt)"); continue; }
        if (lines[0].trim() === FIRST[lang]) { skipped++; continue; }
        lines[0] = FIRST[lang];
        const text = lines.join("\n");
        // Buffer verlangt beim Bearbeiten die Medien erneut (sonst
        // "TikTok posts require at least one image or video").
        const assets = (n.assets || []).map(a => {
          const url = a.source;
          if (!url) return null;
          if (a.type === "video") return { video: { url } };
          if (a.type === "image") return { image: { url } };
          return null;
        }).filter(Boolean);
        const input = { id: n.id, text };
        if (assets.length) input.assets = assets;
        // Buffer verlangt beim Bearbeiten auch die Kanal-Metadaten erneut.
        // YouTube-Titel ist der Suchbegriff -> auch auf den Laender-Hook setzen.
        const m = n.metadata || {};
        if (m.__typename === "InstagramPostMetadata") {
          input.metadata = { instagram: {
            type: m.type, shouldShareToFeed: !!m.shouldShareToFeed, isAiGenerated: !!m.isAiGenerated,
            ...(m.firstComment ? { firstComment: m.firstComment } : {}),
            ...(m.link ? { link: m.link } : {})
          } };
        } else if (m.__typename === "YoutubePostMetadata") {
          const title = (FIRST[lang] + " #Shorts").slice(0, 100);
          input.metadata = { youtube: {
            title,
            categoryId: m.category?.categoryId || "22",
            privacy: m.privacy, madeForKids: !!m.madeForKids, notifySubscribers: !!m.notifySubscribers,
            embeddable: !!m.embeddable, license: m.license, isAiGenerated: !!m.isAiGenerated
          } };
        }
        if (!APPLY) { console.log("DRY   " + platform + " " + day + " " + lang + " | " + FIRST[lang]); changed++; continue; }
        const r = await gql(EDIT, { i: input });
        if (r.errors || r.data?.editPost?.__typename !== "PostActionSuccess") {
          console.log("FAIL  " + platform + " " + day + " " + JSON.stringify(r.errors || r.data));
          continue;
        }
        backup[n.id] = { platform, day, text: n.text };
        console.log("EDIT  " + platform + " " + day + " " + lang + " | " + FIRST[lang]);
        changed++;
      }
    }
  }
  if (APPLY && changed) fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
  console.log(`\nFertig – ${APPLY ? "geändert" : "würde ändern"}: ${changed}, übersprungen: ${skipped}`);
})();
