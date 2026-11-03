#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); } catch (_) {}

// Kampagnen-Skripte (Clip-Index + Text-Engine) liegen im Projekt neben
// videos.json. Der Pfad steht in der Config, damit dieser Agent auch aus
// ~/.n8n/agent heraus funktioniert.
function campaignTools(){
  const base = CFG.campaignPath ? path.dirname(CFG.campaignPath) : path.join(__dirname, "..", "campaign");
  const out = { ci: null, pt: null };
  try { out.ci = require(path.join(base, "clip-index.cjs")); } catch (_) {}
  try { out.pt = require(path.join(base, "post-text.cjs")); } catch (_) {}
  return out;
}
const BUFFER_TOKEN = (process.env.BUFFER_ACCESS_TOKEN || CFG.bufferAccessToken || "");
const BUFFER_CHANNELS = (() => {
  try {
    const c = CFG.bufferChannels || CFG.bufferProfiles || {};
    return typeof c === "object" && !Array.isArray(c) ? c : {};
  } catch (_) { return {}; }
})();
const ORG = "6aafe8c03cf501260e7e406c";
const SITE = "pixelmaps.org";

const H = { Authorization: "Bearer " + BUFFER_TOKEN, "Content-Type": "application/json" };
const log = (m)=>console.log("["+new Date().toISOString()+"] "+m);
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

async function gql(q,v){
  const r = await fetch("https://api.buffer.com",{method:"POST",headers:H,body:JSON.stringify({query:q,variables:v})});
  const j = await r.json();
  if(j.errors) throw new Error(JSON.stringify(j.errors).slice(0,220));
  return j.data;
}

const CH = {
  TikTok: BUFFER_CHANNELS.TikTok,
  Instagram: BUFFER_CHANNELS.Instagram,
  YouTubeShorts: BUFFER_CHANNELS.YouTubeShorts
};

async function loadHints(){
  try{
    const p = path.join(__dirname,"orchestrator-out.json");
    if(fs.existsSync(p)) return JSON.parse(fs.readFileSync(p,"utf8"));
  }catch(_){}
  return null;
}

async function getScheduled(){
  const Q = `query($o:OrganizationId!,$f:PostsFiltersInput!){posts(input:{organizationId:$o,filter:$f,sort:[{field:dueAt,direction:asc}]}){edges{node{id dueAt status channelService}}}}`;
  const all = [];
  const now = new Date();
  for(let t=new Date(now.getTime()-864e5); t<new Date(now.getTime()+90*864e5); t=new Date(t.getTime()+10*864e5)){
    const e = new Date(Math.min(t.getTime()+10*864e5, now.getTime()+90*864e5));
    for(const name of ["TikTok","Instagram","YouTubeShorts"]){
      const cid = CH[name];
      if(!cid) continue;
      const f = {channelIds:[cid], status:["scheduled"], dueAt:{start:t.toISOString(),end:e.toISOString()}};
      try{
        const d = await gql(Q,{o:ORG,f});
        all.push(...(d.posts.edges||[]).map(x=>Object.assign({chan:name},x.node)));
        await sleep(1500);
      }catch(e){
        if(String(e.message).includes("RATE_LIMIT")) await sleep(15000);
      }
    }
  }
  const seen=new Set(); return all.filter(n=>seen.has(n.id)?false:seen.add(n.id));
}

function withUtm(url, src, content){
  try{
    const u = new URL(url);
    u.searchParams.set("utm_source", src.toLowerCase());
    u.searchParams.set("utm_medium", "shorts");
    u.searchParams.set("utm_campaign", "pixelmaps-orch");
    u.searchParams.set("utm_content", content||"intl");
    return u.origin + u.pathname + "?" + u.searchParams.toString();
  }catch(_){ return url; }
}

// Liefert einen Clip, der als Datei existiert und zur Sprache passt.
function pickClipFor(lang){
  const { ci } = campaignTools();
  if(!ci || typeof ci.pickClip !== "function") return null;
  try{
    const idx = ci.loadClipIndex();
    const seed = Math.floor(Date.now()/1000);
    return ci.pickClip(idx, lang, seed, new Set()) || ci.pickClip(idx, "en", seed, new Set()) || null;
  }catch(_){ return null; }
}

async function hasClip(url){
  try{ const r = await fetch(url,{method:"HEAD",signal:AbortSignal.timeout(8000)}); return r.ok; }catch(_){return false;}
}

async function createPost({channelId, platform, text, title, assetUrl, dueAt}){
  const mediaTitle = String(title || text.split("\n")[0] || "").slice(0, 95);
  const input = {
    text,
    channelId,
    schedulingType: platform === "Instagram" ? "notification" : "automatic",
    mode: "customScheduled",
    dueAt,
    needsApproval: false,
    assets: []
  };
  if(assetUrl && assetUrl.match(/\.mp4(\?|$)/i)){
    input.assets = [{video:{url:assetUrl, metadata:{title:mediaTitle}}}];
    if(platform === "YouTubeShorts") input.metadata = {youtube:{title:mediaTitle, categoryId:"22", privacy:"public"}};
    else if(platform === "Instagram") input.metadata = {instagram:{type:"reel", shouldShareToFeed:true}};
  }else if(assetUrl){
    input.assets = [{image:{url:assetUrl}}];
  }
  const q = `mutation($i:CreatePostInput!){createPost(input:$i){... on PostActionSuccess{ post{ id } } ... on MutationError{ message }}}`;
  const d = await gql(q,{i:input});
  return !!(d.createPost && (d.createPost.post || d.createPost.__typename === "PostActionSuccess"));
}

async function run(){
  if(!BUFFER_TOKEN){ console.error("Kein BUFFER_ACCESS_TOKEN"); process.exit(1); }
  const hints = await loadHints();
  if(!hints || !hints.winners || hints.winners.length===0){ log("Kein orchestrator-out.json oder keine Gewinner - überspringe"); process.exit(0); }
  const scheduled = await getScheduled();
  const haveDays = new Set(scheduled.filter(s=>s.dueAt).map(s=>s.dueAt.slice(0,10)));
  const byChan = {TikTok:0,Instagram:0,YouTubeShorts:0};
  for(const s of scheduled){ if(byChan[s.chan]!==undefined) byChan[s.chan]++; }
  log("Belegt: "+haveDays.size+" Tage | TikTok:"+byChan.TikTok+" IG:"+byChan.Instagram+" YT:"+byChan.YouTubeShorts);

  const winners = hints.winners;
  const loc = {}; if(Array.isArray(hints.localized)){ for(const l of hints.localized) loc[l.ideaId]=l; }
  const now = new Date();
  let added=0;
  const platforms=["TikTok","Instagram","YouTubeShorts"];
  for(let d=1; d<=30 && added<6; d++){
    const dt = new Date(now.getTime()+d*864e5);
    dt.setHours(16,0,0,0);
    const day = dt.toISOString().slice(0,10);
    if(haveDays.has(day)) continue;
    for(const pl of platforms){
      if((byChan[pl]||0)>=7) continue;
      const w = winners[added % winners.length];
      const l = loc[w.ideaId]||{};
      const lang = "en";
      const clip = pickClipFor(lang);
      const asset = clip ? clip.url : null;
      // Ohne Video ist ein TikTok/Reel-Post wertlos -> lieber ueberspringen.
      if(!asset || !(await hasClip(asset))){
        log("SKIP "+pl+" "+day+" (kein erreichbarer Clip)");
        continue;
      }
      // Text und Titel kommen aus der gemeinsamen Text-Engine, nicht mehr aus
      // dem LLM-Hook ("Travel the globe.") – der verkaufte nichts.
      const { pt } = campaignTools();
      const built = (pt && pt.buildPost)
        ? pt.buildPost({platform: pl, lang, date: day, clipTitle: clip.title, salt: added})
        : {text: (l.en || w.hook || "Explore the world.") + "\n\n" + withUtm("https://"+SITE, pl, w.ideaId), title: l.en || w.hook || "PixelMaps"};
      const ok = await createPost({channelId:CH[pl], platform: pl, text: built.text, title: built.title, assetUrl: asset, dueAt: dt.toISOString()});
      if(ok){
        log("ADD "+pl+" "+day+" | "+built.title);
        haveDays.add(day);
        byChan[pl]++;
        added++;
      }else{
        log("SKIP "+pl+" "+day);
      }
      await sleep(6000);
      if(added>=6) break;
    }
  }
  console.log(JSON.stringify({ok:true,added,byChan},null,2));
}

run().catch(e=>{if(String(e.message).includes("RATE_LIMIT")){console.log(JSON.stringify({ok:false,reason:"rate_limited"}));process.exit(0);} console.error("FEHLER:", e.message); process.exit(1);});
