// Ersetzt den aktuellen Buffer-Zeitplan durch die Kampagnen-Videos.
//   node scripts/campaign/push-buffer.mjs status    – zeigt geplante Posts
//   node scripts/campaign/push-buffer.mjs replace   – löscht alle scheduled Posts
//                                                     und plant Kampagnen-Videos ein
//   MAX_PER_CHANNEL=9 (Free-Plan erlaubt max. 10 scheduled pro Kanal)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildPost } = require("./post-text.cjs");
const { langOf } = require("./clip-index.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(__dirname, "..", "..");
const realCfg = "/Users/up/.n8n/agent/config.json";
const cfg = JSON.parse(fs.readFileSync(realCfg, "utf8"));
const TOKEN = cfg.bufferAccessToken;
const ORG = cfg.bufferOrgId || "6aafe8c03cf501260e7e406c";
const CH = cfg.bufferChannels || {};
const PLATFORMS = ["TikTok", "Instagram", "YouTubeShorts"];
const VIDEOS = JSON.parse(fs.readFileSync(path.join(__dirname, "videos.json"), "utf8"));
const STATE = path.join(__dirname, ".buffer-state.json");
const MAX = parseInt(process.env.MAX_PER_CHANNEL || "9", 10);
const BASE_URL = "https://pixelmaps.org/clips/campaign";

const H = { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let _rl = 0;
async function gql(query, vars) {
  const r = await fetch("https://api.buffer.com", {
    method: "POST", headers: H, body: JSON.stringify({ query, variables: vars })
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (_) { j = { raw: txt }; }
  if (j.errors && j.errors.length) {
    if ((j.errors[0].extensions || {}).code === "RATE_LIMIT_EXCEEDED") {
      _rl++;
      const wait = Math.min(120 * _rl * 1000, 10 * 60 * 1000);
      console.log(`    Rate-Limit (#${_rl}): warte ${Math.round(wait / 1000)}s ...`);
      await sleep(wait);
      return gql(query, vars);
    }
    throw new Error(j.errors[0].message + " · " + txt.slice(0, 160));
  }
  _rl = 0;
  return j;
}

async function fetchPosts() {
  const j = await gql(`query($o: OrganizationId!){ posts(first:100,input:{organizationId:$o}){ edges{ node{ id channelId status dueAt } } } }`, { o: ORG });
  return (j.data.posts.edges || []).map((e) => e.node);
}

async function deletePost(id) {
  const j = await gql(`mutation($i: DeletePostInput!){ deletePost(input:$i){ ... on DeletePostSuccess { id } ... on VoidMutationError { message } } }`, { i: { id } });
  return j.data.deletePost;
}

async function createPost(input) {
  const j = await gql(`mutation($i: CreatePostInput!){ createPost(input:$i){ ... on PostActionSuccess{ post{ id } } ... on MutationError{ message } } }`, { i: input });
  return j.data.createPost;
}

function assetFor(platform, videoId, title) {
  const base = `${BASE_URL}/${videoId}.mp4`;
  switch (platform) {
    case "TikTok":
      return { video: { url: base, metadata: { title } } };
    case "YouTubeShorts":
      return { video: { url: base, metadata: { title } },
               metadata: { youtube: { title, categoryId: "22", privacy: "public" } } };
    default:
      return { video: { url: base, metadata: { title } },
               metadata: { instagram: { type: "reel", shouldShareToFeed: true } } };
  }
}

function isoDay(offset) {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}

async function status() {
  const rows = await fetchPosts();
  for (const p of PLATFORMS) {
    const cid = CH[p];
    const sched = rows.filter((r) => r.channelId === cid && r.status === "scheduled");
    console.log(`${p.padEnd(12)} scheduled=${sched.length}`);
    for (const s of sched) console.log(`   ${s.id} @ ${s.dueAt}`);
  }
}

async function replace() {
  let list = VIDEOS;
  if (process.env.EN === "1") list = VIDEOS.filter((v) => /-en-/.test(v.id));
  console.log(`Nutze ${list.length} Videos${process.env.EN === "1" ? " (EN-Modus)" : ""}.`);
  const rows = await fetchPosts();
  const all = rows.filter((r) => r.status === "scheduled");
  console.log(`Lösche ${all.length} geplante Posts ...`);
  let del = 0;
  for (const r of all) {
    try {
      const d = await deletePost(r.id);
      if (d && d.id) { del++; console.log(`  DEL ${r.id}`); }
      else console.log(`  FEHLER DEL ${r.id}: ${(d && d.message) || "?"}  (überspringe)`);
    } catch (e) {
      console.log(`  FEHLER DEL ${r.id}: ${e.message}`);
    }
    await sleep(1100);
  }
  console.log(`Gelöscht: ${del}/${all.length}`);

  const state = { scheduled: [] };
  let created = 0;
  for (let p = 0; p < PLATFORMS.length; p++) {
    const platform = PLATFORMS[p];
    const cid = CH[platform];
    const used = new Set();
    for (let k = 0; k < list.length; k++) {
      const v = list[k];
      if (used.has(v.id)) continue;
      used.add(v.id);
      const day = isoDay(k + 1);
      const hh = 15 + (k % 4);
      const dueAt = `${day}T${String(hh).padStart(2, "0")}:00:00Z`;
      // Text + Titel je Kanal (campaign/post-text.cjs).
      const built = buildPost({ platform, lang: langOf(v.id), date: day, clipTitle: v.title });
      const title = built.title;
      const text = built.text;
      const asset = assetFor(platform, v.id, title);
      const input = {
        text, channelId: cid, assets: [{ video: asset.video }], metadata: asset.metadata,
        schedulingType: platform === "Instagram" ? "notification" : "automatic",
        mode: "customScheduled", dueAt, needsApproval: false
      };
      try {
        const d = await createPost(input);
        if (d && d.post) {
          created++;
          state.scheduled.push({ videoId: v.id, platform, postId: d.post.id, dueAt });
          console.log(`OK  ${platform.padEnd(12)} ${day} ${hh}:00  ${v.id.padEnd(30)} ${d.post.id}`);
        } else {
          console.log(`FEHLER ${platform} ${v.id}: ${(d && d.message) || "?"}`);
        }
      } catch (e) {
        console.log(`CRASH ${platform} ${v.id}: ${e.message}`);
      }
      await sleep(1100);
    }
  }
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(`Fertig – neu geplant: ${created} Posts. State: ${STATE}`);
}

// ── swap: nur die ZUKUNFTIG geplanten Posts ersetzen ────────────────────
// "replace" loescht alles und plant alle Videos neu. Das ist hier zu viel:
// es wuerde bereits ueberfaellige (eingereichte) Posts mitloeschen und weit
// ueber dem Free-Limit von 10 scheduled Posts pro Kanal landen.
//
//   node scripts/campaign/push-buffer.mjs swap              # Dry-Run
//   node scripts/campaign/push-buffer.mjs swap --commit     # ausfuehren
const CONCEPT_IDS = (process.env.SELECT || "c1-proof-en,c5-dialog-en")
  .split(",").map((x) => x.trim()).filter(Boolean);

async function swap() {
  const commit = process.argv.includes("--commit");
  // START_OFFSET=0 plant ab heute (Standard 1 = ab morgen).
  const START = Number.isFinite(Number(process.env.START_OFFSET)) ? Number(process.env.START_OFFSET) : 1;
  const rows = await fetchPosts();
  const now = Date.now();
  const sched = rows.filter((r) => r.status === "scheduled");
  const past = sched.filter((r) => new Date(r.dueAt).getTime() <= now);
  const future = sched.filter((r) => new Date(r.dueAt).getTime() > now);

  console.log(`scheduled gesamt: ${sched.length}  bereits faellig (bleiben): ${past.length}  kuenftig (werden ersetzt): ${future.length}`);
  for (const r of past) console.log(`  BEHALT  ${r.dueAt.slice(0,16)}  ${r.channelId}  ${r.id}`);
  for (const r of future) console.log(`  LOESCH  ${r.dueAt.slice(0,16)}  ${r.channelId}  ${r.id}`);

  const list = CONCEPT_IDS
    .map((id) => VIDEOS.find((v) => v.id === id))
    .filter(Boolean);
  const missing = CONCEPT_IDS.filter((id) => !VIDEOS.some((v) => v.id === id));
  if (missing.length) throw new Error("nicht in videos.json: " + missing.join(", "));
  console.log(`\nNeu einplanen (${list.length} Clips x ${PLATFORMS.length} Kanaele):`);
  for (const v of list) {
    console.log(`  ${v.id.padEnd(24)} ${v.title}  ->  https://pixelmaps.org/clips/campaign/${v.id}.mp4`);
  }

  // Sicherheitsnetz: vorherige Zustaende immer sichern
  const BACKUP = STATE + ".bak";
  fs.writeFileSync(BACKUP, fs.existsSync(STATE) ? fs.readFileSync(STATE) : "[]");
  console.log(`\nBackup des alten State: ${BACKUP}`);

  if (!commit) {
    console.log("\nDry-Run. Nichts geaendert. Mit '--commit' ausfuehren.");
    return;
  }

  for (const r of future) {
    try {
      const d = await deletePost(r.id);
      if (d && d.id) console.log(`  DEL ok ${r.id}`);
      else console.log(`  DEL fehlgeschlagen ${r.id}: ${(d && d.message) || "?"}`);
    } catch (e) { console.log(`  DEL Fehler ${r.id}: ${e.message}`); }
    await sleep(1100);
  }

  const state = { scheduled: [] };
  let created = 0;
  for (let p = 0; p < PLATFORMS.length; p++) {
    const platform = PLATFORMS[p];
    const cid = CH[platform];
    for (let k = 0; k < list.length; k++) {
      const v = list[k];
      const day = isoDay(k + START);
      const hh = 15 + (k % 4);
      const dueAt = `${day}T${String(hh).padStart(2, "0")}:00:00Z`;
      const built = buildPost({ platform, lang: langOf(v.id), date: day, clipTitle: v.title, salt: k });
      const title = built.title;
      const asset = assetFor(platform, v.id, title);
      const input = {
        text: built.text,
        channelId: cid, assets: [{ video: asset.video }], metadata: asset.metadata,
        schedulingType: platform === "Instagram" ? "notification" : "automatic",
        mode: "customScheduled", dueAt, needsApproval: false
      };
      try {
        const d = await createPost(input);
        if (d && d.post) {
          created++;
          state.scheduled.push({ videoId: v.id, platform, postId: d.post.id, dueAt });
          console.log(`  OK ${platform.padEnd(12)} ${dueAt.slice(0,16)} ${v.id} ${d.post.id}`);
        } else console.log(`  FEHLER ${platform} ${v.id}: ${(d && d.message) || "?"}`);
      } catch (e) { console.log(`  CRASH ${platform} ${v.id}: ${e.message}`); }
      await sleep(1100);
    }
  }
  state.scheduled.push(...past.map((r) => ({ videoId: "(unveraendert)", platform: "-", postId: r.id, dueAt: r.dueAt })));
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(`\nFertig. Neu geplant: ${created} Posts. State: ${STATE}`);
}

const cmd2 = process.argv[2] || "status";
(async () => {
  if (cmd2 === "replace") await replace();
  else if (cmd2 === "swap") await swap();
  else await status();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
