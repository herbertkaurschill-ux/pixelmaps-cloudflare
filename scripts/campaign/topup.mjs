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
const CFG = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".n8n/agent/config.json"), "utf8"));
const ORG = CFG.bufferOrgId || "6aafe8c03cf501260e7e406c";
const CH = CFG.bufferChannels || {};
const MAX = 7, HORIZON = 13, DRY = process.argv.includes("--dry");
const H = { Authorization: "Bearer " + CFG.bufferAccessToken, "Content-Type": "application/json" };

const TIME = { YouTubeShorts: "16:45:00Z", TikTok: "17:15:00Z", Instagram: "17:30:00Z" };
const TAGS = {
  de: "#Weltkarte #Pixel", en: "#worldmap #pixel", es: "#mapamundi #pixel", fr: "#cartedumonde #pixel",
  it: "#mappamondo #pixel", pt: "#mapamundo #pixel", tr: "#dünyaharitası #pixel", ru: "#картамира #пиксель",
  hi: "#दुनियाकानक्शा #पिक्सेल", zh: "#世界地图 #像素",
};

const backlog = JSON.parse(fs.readFileSync(path.join(HERE, "backlog.json"), "utf8"));
const titles = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(HERE, "videos.json"), "utf8")).map((v) => [v.id, v.title]));
const CLIP_INDEX = loadClipIndex();
const STATE_FILE = path.join(HERE, ".topup-state.json");
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { done: {} };

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const gql = async (q, v) => (await fetch("https://api.buffer.com", { method: "POST", headers: H, body: JSON.stringify({ query: q, variables: v }) })).json();

const titleFor = (video) => titles[video] || (CLIP_INDEX.byId[video] && CLIP_INDEX.byId[video].title) || video;

const textFor = (item) => {
  const lang = langOf(item.video);
  return `${titleFor(item.video)} · pixelmaps.org #PixelMaps ${TAGS[lang] || ""}`.trim();
};

// Dynamische Reserve: wenn die kuratierte Backlog leer ist, nehmen wir die
// noch nicht verwendeten Live-Clips. So laeuft die Planung nicht leer.
function dynamicItems(platform, usedVideos) {
  return CLIP_INDEX.all
    .filter((c) => !usedVideos.has(c.id))
    .map((c) => ({ id: `auto-${c.id}`, platform, video: c.id }));
}

(async () => {
  const j = await gql(`query($o: OrganizationId!){ posts(first:100,input:{organizationId:$o}){ edges{ node{ id channelId status dueAt text } } } }`, { o: ORG });
  const rows = (j.data?.posts?.edges || []).map((e) => e.node);
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
      const text = textFor(item);
      if (chanText.has(text)) { state.done[item.id] = "dup-same-channel"; continue; }
      const day = days.find((d) => !used.has(d));
      if (!day) break;
      const url = `https://pixelmaps.org/clips/campaign/${item.video}.mp4`;
      const asset = { video: { url, metadata: { title: titleFor(item.video) } } };
      const metadata = platform === "YouTubeShorts"
        ? { youtube: { title: titleFor(item.video), categoryId: "22", privacy: "public" } }
        : platform === "Instagram"
          ? { instagram: { type: "reel", shouldShareToFeed: true } }
          : {};
      const input = { text, channelId: cid, assets: [asset], metadata, schedulingType: platform === "Instagram" ? "notification" : "automatic", mode: "customScheduled", dueAt: `${day}T${TIME[platform]}`, needsApproval: false };
      if (DRY) { console.log(`DRY  ${day} ${platform.padEnd(13)} ${item.id}`); scheduled++; used.add(day); continue; }
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
