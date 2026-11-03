#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); } catch (_) {}
// Reihenfolge: env -> config -> localhost -> Docker-Hostname. Aus dem
// n8n-Container geht nur host.docker.internal, vom Mac aus nur localhost;
// config.ollamaUrl zeigt auf host.docker.internal und ist damit fuer den
// launchd-Lauf (Host) immer tot (ENOTFOUND).
const OLLAMA_CANDIDATES = [process.env.OLLAMA_URL, CFG.ollamaUrl, "http://127.0.0.1:11434", "http://host.docker.internal:11434"]
  .filter(Boolean);
let OLLAMA = OLLAMA_CANDIDATES[0];
const MODEL = process.env.OLLAMA_MODEL || CFG.model || "qwen2.5:7b";

async function pickOllama(tries = 3, waitMs = 10000) {
  for (let i = 0; i < tries; i++) {
    for (const u of OLLAMA_CANDIDATES) {
      try {
        const r = await fetch(u + "/api/tags", { signal: AbortSignal.timeout(4000) });
        if (r.ok) { OLLAMA = u; return u; }
      } catch (_) {}
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error("Ollama nicht erreichbar: " + OLLAMA_CANDIDATES.join(", "));
}
const SITE = "pixelmaps.org";

const used = [];
function loadUsed(dir){
  if(!fs.existsSync(dir)) return;
  const walk=(d)=>{
    try {
      for(const e of fs.readdirSync(d,{withFileTypes:true})){
        const p=path.join(d,e.name);
        if(e.isDirectory()) walk(p);
        else if(e.name==="posts.json"){
          try{
            const j=JSON.parse(fs.readFileSync(p,"utf8"));
            (j.posts||[]).forEach(x=>used.push(x.hook||x.title));
          }catch(_){}
        }
      }
    } catch(_){}
  }; walk(dir);
}

async function ollama(prompt, sys){
  const res = await fetch(OLLAMA+"/api/chat",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      model:MODEL,
      messages:[
        {role:"system",content:sys||"Du bist ein präziser Marketing-Agent für pixelmaps.org."},
        {role:"user",content:prompt}
      ],
      stream:false,
      format:"json",
      options:{temperature:0.7, top_p:0.9, num_ctx:4096}
    })
  });
  if(!res.ok) throw new Error("Ollama "+res.status+" "+await res.text());
  const d=await res.json();
  const txt=(d.message?.content||"").replace(/```json/gi,"").replace(/```/g,"").trim();
  return JSON.parse(txt);
}

async function getStats(){
  try{
    const r=await fetch("https://pixelmaps.org/api/stats",{signal:AbortSignal.timeout(5000)});
    if(r.ok) return await r.json();
  }catch(_){}
  return null;
}

async function run(){
  const base = path.resolve(__dirname,"..");
  const content = process.env.AGENT_CONTENT || path.join(base,"content");
  loadUsed(content);
  const stats = await getStats();
  const remaining = typeof stats?.remaining === 'number' ? stats.remaining : (stats?.remaining ?? "unknown");

  logMsg = (m)=>console.log("["+new Date().toISOString()+"] "+m);
  logMsg("Orchestrator-Start - Modell: "+MODEL);
  logMsg("Ollama: "+await pickOllama());

  // 1) TrendScout
  logMsg("TrendScout läuft...");
  const scout = await ollama(`
Gib 3 globale Ideen für Short-Form-Videos (TikTok/YT Shorts/Reels), die für eine interaktive Weltkarte mit 1€ pro Pixel funktionieren.
Ziel: international (nicht nur DE). Konzentrier dich auf Neugier, nicht auf "Kaufen".
Bereits genutzt: ${used.slice(-20).join(" | ")}
Verbleibende Pixel (echter Wert): ${remaining}
Antworte als JSON: {"ideas":[{"id":"S1","angle":"...","rationale":"...","hook_seed":"..."}]}
`,"Du bist TrendScout. Denk global. Vermeide erfundene Zahlen. Fokus auf Neugier.");

  // 2) HookWriter
  logMsg("HookWriter läuft...");
  const hooks = await ollama(`
Erstelle je Idee 5 kurze Hooks für Vertikal-Video (9:16).
Regeln:
- Max 4 Wörter
- Visuell vorstellbar (Karte/Welt/Punkte/Pixel)
- Kein "Jetzt kaufen", kein aggressiver Clickbait
- Funktionieren auch ohne Ton (lesbar)
- Falls remaining eine Zahl ist und < 10M, kann "Only X left" oder "Nur noch X frei" verwendet werden, aber KEINE erfundenen Zahlen
Ideen: ${JSON.stringify(scout.ideas)}
Antworte als JSON: {"hooks":[{"ideaId":"S1","platform":"all","cands":["...","...","...","...","..."]}]}
`,"Du bist HookWriter. Lieber kurz als clever aber unklar. Englisch zuerst denken.");

  // 3) Critic
  logMsg("Critic läuft...");
  const picked = await ollama(`
Bewerte jede Kandidat nach Skip-Wahrscheinlichkeit 0-10 (10 = sehr hoch, wird geskippt).
Wähle GENAU 1 pro Idee aus, begründe kurz warum du weitergucken würdest.
Kandidaten: ${JSON.stringify(hooks.hooks)}
Antworte als JSON: {"winners":[{"ideaId":"...","hook":"...","score":0,"reason":"..."}]}
`,"Du bist ein kritischer Viewer. Sei streng. Nimm nur Hooks, bei denen du selbst weitergucken würdest.");

  // 4) IntlLocalizer
  logMsg("IntlLocalizer läuft...");
  const loc = await ollama(`
Übersetze nur diese Gewinner in natürliche, kurze Formen für internationale Nutzung.
Sprachen: en, es, fr, it, pt, tr
Regeln: keine erfundenen Zahlen/Preise, "pixelmaps.org" nur für CTA falls gebraucht, kurz halten, klingen natürlich für Muttersprachler.
Gewinner: ${JSON.stringify(picked.winners)}
Antworte als JSON: {"localized":[{"ideaId":"...","en":"...","es":"...","fr":"...","it":"...","pt":"...","tr":"..."}]}
`,"Du bist ein Muttersprachler-Übersetzer für Social Captions. Natürlich und kurz.");

  const out = {
    date: new Date().toISOString().slice(0,10),
    remaining,
    scout: scout.ideas,
    winners: picked.winners,
    localized: loc.localized,
    generatedAt: new Date().toISOString()
  };
  const p = path.join(__dirname,"orchestrator-out.json");
  fs.writeFileSync(p, JSON.stringify(out,null,2));
  logMsg("Fertig - "+p);
  console.log(JSON.stringify({ok:true,file:p,winners:picked.winners.length, remaining}, null, 2));
}

run().catch(e=>{console.error("FEHLER:", e.message); process.exit(1);});
