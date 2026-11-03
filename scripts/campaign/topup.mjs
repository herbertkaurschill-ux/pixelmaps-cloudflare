#!/usr/bin/env node
// Slot-Auffueller: plant Konzept-Videos aus campaign/backlog.json in freie
// Buffer-Slots (max. 10 scheduled pro Kanal), idempotent. Laeuft taeglich im
// 09:10-Job VOR fill-queue, damit unsere Videos zuerst greifen.
//   node scripts/campaign/topup.mjs [--dry]
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { loadClipIndex, langOf } = require("./clip-index.cjs");
const { buildPost } = require("./post-text.cjs");
const CFG = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".n8n/agent/config.json"), "utf8"));
const ORG = CFG.bufferOrgId || "6aafe8c03cf501260e7e406c";
const CH = CFG.bufferChannels || {};
const MAX = 7, HORIZON = 13, DRY = process.argv.includes("--dry");
const H = { Authorization: "Bearer " + CFG.bufferAccessToken, "Content-Type": "application/json" };

const TIME = { YouTubeShorts: "16:45:00Z", TikTok: "17:15:00Z", Instagram: "17:30:00Z" };

const backlog = JSON.parse(fs.readFileSync(path.join(HERE, "backlog.json"), "utf8"));
const titles = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(HERE, "videos.json"), "utf8")).map((v) => [v.id, v.title]));
const CLIP_INDEX = loadClipIndex();
const STATE_FILE = path.join(HERE, ".topup-state.json");
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { done: {} };

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const gql = async (q, v) => (await fetch("https://api.buffer.com", { method: "POST", headers: H, body: JSON.stringify({ query: q, variables: v }) })).json();

// Buffer liefert pro Abfrage nur 10 Posts. Eine einzelne "first:100"-Abfrage
// sah deshalb nur einen Teil der Queue -> belegte Tage erschienen frei und
// wurden doppelt belegt. Darum Zeitfenster (max. 4 Tage) pro Kanal.
const ROWS_Q = `query($o:OrganizationId!,$f:PostsFiltersInput!){posts(input:{organizationId:$o,filter:$f,sort:[{field:dueAt,direction:asc}]}){edges{node{id channelId status dueAt text}}}}`;

async function fetchScheduled(cid, horizonDays = HORIZON) {
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

async function fetchAllScheduled(horizonDays = HORIZON) {
  let rows = [];
  for (const cid of new Set(Object.values(CH))) {
    if (cid) rows.push(...(await fetchScheduled(cid, horizonDays)));
  }
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

const titleFor = (video) => titles[video] || (CLIP_INDEX.byId[video] && CLIP_INDEX.byId[video].title) || video;

// Dynamische Reserve: wenn die kuratierte Backlog leer ist, nehmen wir die
// noch nicht verwendeten Live-Clips. So laeuft die Planung nicht leer.
function dynamicItems(platform, usedVideos) {
  return CLIP_INDEX.all
    .filter((c) => !usedVideos.has(c.id))
    .map((c) => ({ id: `auto-${c.id}`, platform, video: c.id }));
}

(async () => {
  const rows = await fetchAllScheduled(HORIZON);
  const now = Date.now();
  const days = [];
  for (let i = 1; i <= HORIZON; i++) days.push(isoDay(now + i * 86400000));

  let created = 0;
  for (const platform of ["YouTubeShorts", "TikTok", "Instagram"]) {
    const cid = CH[platform];
    if (!cid) continue;
    let scheduled = rows.filter((n) => n.channelId === cid && n.status === "scheduled" && Date.parse(n.dueAt) > now).length;
    const used = new Set(rows.filter((n) => n.channelId === cid && n.dueAt && n.status !== "posted").map((n) => n.dueAt.slice(0, 10)));
    const chanText = new Set(rows.filter((r) => r.channelId === cid).map((r) => (r.text || "").trim()));
    const usedVideos = new Set(
      Object.keys(state.done)
        .filter((k) => state.done[k] !== "dup-same-channel")
        .map((k) => {
          const item = backlog.find((b) => b.id === k);
          return item ? item.video : k.replace(/^auto-/, "");
        })
    );
    const curated = backlog.filter((b) => b.platform === platform && !state.done[b.id]);
    const pending = curated.length ? curated : dynamicItems(platform, usedVideos);
    for (const item of pending) {
      if (scheduled >= MAX) break;
      const day = days.find((d) => !used.has(d));
      if (!day) break;
      // Text + Titel je Kanal und Sprache (campaign/post-text.cjs);
      // salt rotiert den Hook, falls der Text auf dem Kanal schon steht.
      let built = null;
      for (let salt = 0; salt < 7; salt++) {
        const cand = buildPost({ platform, lang: langOf(item.video), date: day, clipTitle: titleFor(item.video), salt });
        if (!built) built = cand;
        if (!chanText.has(cand.text.trim())) { built = cand; break; }
      }
      const text = built.text;
      const mediaTitle = built.title;
      const url = `https://pixelmaps.org/clips/campaign/${item.video}.mp4`;
      const asset = { video: { url, metadata: { title: mediaTitle } } };
      const metadata = platform === "YouTubeShorts"
        ? { youtube: { title: mediaTitle, categoryId: "22", privacy: "public" } }
        : platform === "Instagram"
          ? { instagram: { type: "reel", shouldShareToFeed: true } }
          : {};
      const input = { text, channelId: cid, assets: [asset], metadata, schedulingType: platform === "Instagram" ? "notification" : "automatic", mode: "customScheduled", dueAt: `${day}T${TIME[platform]}`, needsApproval: false };
      if (DRY) { console.log(`DRY  ${day} ${platform.padEnd(13)} ${item.id} | ${text.split("\n")[0]}`); chanText.add(text.trim()); scheduled++; used.add(day); continue; }
      const r = await gql(`mutation($i:CreatePostInput!){ createPost(input:$i){ ... on PostActionSuccess{ post{ id } } ... on MutationError{ message } } }`, { i: input });
      const d = r.data?.createPost;
      if (d && d.post) { created++; scheduled++; used.add(day); state.done[item.id] = d.post.id; chanText.add(text); console.log(`OK   ${day} ${platform.padEnd(13)} ${item.id} ${d.post.id}`); }
      else console.log(`FEHLER ${day} ${platform} ${item.id}: ${d?.message || JSON.stringify(r).slice(0, 120)}`);
      await new Promise((res) => setTimeout(res, 1200));
    }
  }
  if (!DRY) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  console.log(`Fertig – neu geplant: ${created}${DRY ? " (dry)" : ""}`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
