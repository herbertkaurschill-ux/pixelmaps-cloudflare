#!/usr/bin/env node
// Idempotenter Buffer-Queue-Füller: hält pro Kanal max. 10 scheduled Posts
// und plant fehlende Tage (morgen .. +13) mit Design-/Sprachrotation nach.
const fs = require("fs");
const path = require("path");
const cfg = JSON.parse(fs.readFileSync(path.join(require("os").homedir(), ".n8n/agent/config.json"), "utf8"));
const H = { Authorization: "Bearer " + cfg.bufferAccessToken, "Content-Type": "application/json" };
const ORG = cfg.bufferOrgId || "6aafe8c03cf501260e7e406c";
const CH = cfg.bufferChannels || {};
const MAX = 7, WANT = 14;
const DRY = process.argv.includes("--dry");
const TRIM_ONLY = process.argv.includes("--trim");
// Beim Trimmen vor dem Tages-Push muss 1 Slot pro Kanal frei bleiben,
// sonst plant der Agent seinen frischen Post hinter die volle Queue und
// der naechste Lauf trimmt ihn als "am weitesten entfernt" wieder weg.
const RESERVE = (() => {
  const i = process.argv.indexOf("--reserve");
  const n = i >= 0 ? Number(process.argv[i + 1]) : 0;
  return Number.isFinite(n) && n > 0 ? Math.min(MAX, Math.floor(n)) : 0;
})();
const TRIM_TARGET = Math.max(0, MAX - RESERVE);
const { loadClipIndex, pickClip } = require("./campaign/clip-index.cjs");
const { buildPost, langForDate } = require("./campaign/post-text.cjs");
const CLIP_INDEX = loadClipIndex();

const DAY0 = Date.parse("2026-09-22T00:00:00Z") / 86400000;
function dayInfo(dStr) {
  const idx = Math.floor(Date.parse(dStr + "T00:00:00Z") / 86400000) - DAY0;
  // Sprache wie im Tagesvideo (campaign/post-text.cjs), Design im Wechsel.
  return { design: (idx % 2) === 0 ? "neon" : "pop", lang: langForDate(dStr) };
}
function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

async function gql(q, v) {
  const r = await fetch("https://api.buffer.com", { method: "POST", headers: H, body: JSON.stringify({ query: q, variables: v }) });
  return r.json();
}

// Buffer liefert pro Abfrage nur 10 Posts. Eine einzelne "first:100"-Abfrage
// sah deshalb nur einen Teil der Queue -> belegte Tage erschienen frei und
// wurden doppelt belegt. Darum Zeitfenster (max. 4 Tage) pro Kanal.
const ROWS_Q = `query($o:OrganizationId!,$f:PostsFiltersInput!){posts(input:{organizationId:$o,filter:$f,sort:[{field:dueAt,direction:asc}]}){edges{node{id channelId status dueAt text}}}}`;

async function fetchScheduled(cid, horizonDays = WANT) {
  const out = [];
  const now = Date.now();
  const end = now + horizonDays * 864e5;
  for (let t = now - 2 * 864e5; t < end; t += 4 * 864e5) {
    const e = Math.min(t + 4 * 864e5, end);
    const f = { channelIds: [cid], status: ["scheduled"], dueAt: { start: new Date(t).toISOString(), end: new Date(e).toISOString() } };
    const j = await gql(ROWS_Q, { o: ORG, f });
    out.push(...(((j.data || {}).posts || {}).edges || []).map((x) => x.node));
  }
  return out;
}

async function fetchAllScheduled(horizonDays = WANT) {
  let rows = [];
  for (const cid of new Set(Object.values(CH))) {
    if (cid) rows.push(...(await fetchScheduled(cid, horizonDays)));
  }
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

async function deletePost(id) {
  const r = await gql(`mutation($i:DeletePostInput!){ deletePost(input:$i){ __typename } }`, { i: { id } });
  return !!(r.data && r.data.deletePost);
}

function modeFor(platform, dueAt) {
  const input = {
    text: "", channelId: CH[platform], assets: [], metadata: {},
    schedulingType: platform === "Instagram" ? "notification" : "automatic",
    mode: "customScheduled", dueAt, needsApproval: false,
  };
  return input;
}

(async () => {
  const rows = await fetchAllScheduled(WANT);
  const now = Date.now();
  const want = {};
  for (let i = 1; i <= WANT; i++) {
    const d = isoDate(now + i * 86400000);
    want[d] = dayInfo(d);
  }
  let created = 0;
  const usedClips = new Set();
  for (const [platform, cid] of Object.entries(CH)) {
    if (!cid) continue;
    let scheduled = rows.filter((n) => n.channelId === cid && n.status === "scheduled" && Date.parse(n.dueAt) > now).length;
    // Texte, die auf diesem Kanal schon geplant sind -> keine Doppelten.
    const chanTexts = new Set(rows.filter((n) => n.channelId === cid).map((n) => (n.text || "").trim()));
    const have = new Set(rows.filter((n) => n.channelId === cid && n.dueAt && n.status !== "posted").map((n) => n.dueAt.slice(0, 10)));
    // Ueberschuss abbauen: der Tages-Agent (frische KI-Beitraege) braucht
    // einen freien Slot pro Kanal, sonst schlaegt sein Push mit "limit
    // reached" fehl.
    if (scheduled > TRIM_TARGET) {
      const far = rows
        .filter((n) => n.channelId === cid && n.status === "scheduled" && Date.parse(n.dueAt) > now)
        .sort((a, b) => Date.parse(b.dueAt) - Date.parse(a.dueAt));
      for (const p of far.slice(0, scheduled - TRIM_TARGET)) {
        if (DRY) { console.log(`DRY  trimme ${p.dueAt} ${p.id}`); continue; }
        if (await deletePost(p.id)) { console.log(`TRIM ${p.dueAt} ${p.id}`); scheduled--; }
      }
    }
    for (const [day, info] of Object.entries(want)) {
      if (scheduled >= MAX) break;
      if (TRIM_ONLY) break;
      if (have.has(day)) continue;
      // Nur Clips verwenden, die wirklich als Datei existieren (live).
      const clip = pickClip(CLIP_INDEX, info.lang, Math.floor(Math.random() * 1e6), usedClips);
      if (!clip) { console.log(`SKIP ${day} ${platform}: kein Clip fuer ${info.lang}`); continue; }
      usedClips.add(clip.id);
      // Text + Titel je Kanal und Sprache (campaign/post-text.cjs).
      // salt rotiert den Hook, falls der Text auf dem Kanal schon steht.
      let built = null;
      for (let salt = 0; salt < 7; salt++) {
        const cand = buildPost({ platform, lang: info.lang, date: day, design: info.design, salt, clipTitle: clip.title });
        if (!built) built = cand;
        if (!chanTexts.has(cand.text.trim())) { built = cand; break; }
      }
      const { text, title } = built;
      const asset = platform === "TikTok"
        ? { video: { url: clip.url, metadata: { title } } }
        : platform === "YouTubeShorts"
          ? { video: { url: clip.url, metadata: { title } }, metadata: { youtube: { title, categoryId: "22", privacy: "public" } } }
          : { video: { url: clip.url, metadata: { title } }, metadata: { instagram: { type: "reel", shouldShareToFeed: true } } };
      const input = { text, channelId: cid, assets: [{ video: asset.video }], metadata: asset.metadata, schedulingType: platform === "Instagram" ? "notification" : "automatic", mode: "customScheduled", dueAt: `${day}T16:00:00Z`, needsApproval: false };
      if (DRY) { console.log(`DRY ${day} ${platform.padEnd(12)} ${info.design}|${info.lang} ${clip.id} | ${text.split("\n")[0]}`); chanTexts.add(text.trim()); scheduled++; continue; }
      try {
        const r = await gql(`mutation($i:CreatePostInput!){ createPost(input:$i){ ... on PostActionSuccess{ post{ id } } ... on MutationError{ message } } }`, { i: input });
        const d = r.data && r.data.createPost;
        if (d && d.post) { created++; scheduled++; chanTexts.add(text.trim()); console.log(`OK  ${day} ${platform.padEnd(12)} ${info.design}|${info.lang} ${clip.id} ${d.post.id}`); }
        else console.log(`FEHLER ${day} ${platform}: ${(d && d.message) || JSON.stringify(r).slice(0, 120)}`);
      } catch (e) { console.log(`CRASH ${day} ${platform}: ${e.message}`); }
    }
  }
  console.log(`Fertig – neu geplant: ${created}${DRY ? " (dry)" : ""}`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });