#!/usr/bin/env node
/**
 * PixelMaps Marketing-Content-Agent
 * ---------------------------------
 * - Generiert taeglich neue Marketing-Ideen (Ollama, lokal)
 * - Erstellt Beitraege fuer TikTok, Instagram und YouTube Shorts
 * - Speichert sie strukturiert (JSON + Review-Markdown)
 * - Aktualisiert den Wochenplan
 * - Stellt Beitraege zur Freigabe bereit (Review-Ordner + Buffer-API)
 *
 * Lauf durch n8n: Schedule Trigger -> Execute Command: node .../agent/agent.js
 */
const fs = require("fs");
const path = require("path");

let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); } catch (_) {}
const OLLAMA_URL = (process.env.OLLAMA_URL || CFG.ollamaUrl || "http://host.docker.internal:11434");
const MODEL = (process.env.OLLAMA_MODEL || CFG.model || "qwen2.5:7b");
const BASE = process.env.AGENT_BASE ? path.resolve(process.env.AGENT_BASE) : path.resolve(__dirname, "..");
const CONTENT = process.env.AGENT_CONTENT || path.join(BASE, "content");
const BUFFER_TOKEN = (process.env.BUFFER_ACCESS_TOKEN || CFG.bufferAccessToken || "");
const BUFFER_CHANNELS = (() => {
  try {
    const c = CFG.bufferChannels || CFG.bufferProfiles || {};
    return typeof c === "object" && !Array.isArray(c) ? c : {};
  } catch (_) { return {}; }
})();
const SITE = "pixelmaps.org";

async function getSiteStats(){
  try{
    const r = await fetch("https://pixelmaps.org/api/stats",{signal: AbortSignal.timeout(5000)});
    if(r.ok) return await r.json();
  }catch(_){}
  return null;
}

function loadOrchestratorHints(){
  try{
    const p = path.join(__dirname, "orchestrator-out.json");
    if(fs.existsSync(p)){
      const d = JSON.parse(fs.readFileSync(p,"utf8"));
      if(d && Array.isArray(d.winners)) return d;
    }
  }catch(_){}
  return null;
}

function withUtm(url, post, iso){
  try{
    const u = new URL("https://"+url.replace(/^https?:\/\//,""));
    u.searchParams.set("utm_source", (post.platform||"").toLowerCase());
    u.searchParams.set("utm_medium", "shorts");
    u.searchParams.set("utm_campaign", "pixelmaps-loop-"+(iso||""));
    u.searchParams.set("utm_content", (post.ideaId||"organic").toLowerCase());
    return u.origin + u.pathname + (u.search ? "?"+u.searchParams.toString() : "");
  }catch(_){ return url; }
}

const log = [];
const logMsg = (m) => { log.push(m); console.log("[" + new Date().toISOString() + "] " + m); };

const isoWeek = (d) => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((t - firstThursday) / (7 * 24 * 3600 * 1000));
};

const weekdayDE = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
const pad = (n) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  const iso = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  return { iso, year: d.getFullYear(), month: pad(d.getMonth()+1), week: isoWeek(d), weekday: weekdayDE[d.getDay()] };
};

const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const fmtKnown = (v) => (v === undefined || v === null || v === "" ? "unbekannt" : String(v));

// Ideenspeicher: bereits verwendete Ideen-IDs/Titel/Hooks, damit taeglich neue Ideen entstehen.
function usedIdeas() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "posts.json") {
        try {
          const d = JSON.parse(fs.readFileSync(p, "utf8"));
          for (const i of d.ideas || []) out.push(`${i.id} "${i.title}" (${i.target})`);
          for (const s of d.posts || []) out.push(`Post ${s.platform}: "${s.hook || s.title}"`);
        } catch (_) {}
      }
    }
  };
  if (fs.existsSync(CONTENT)) walk(CONTENT);
  return out.slice(-40);
}

// Eigene Kennzahlen von pixelmaps.org (D1). Nicht erreichbar => null (unbekannt).
async function dayMetrics(iso) {
  try {
    const r = await fetch(`https://pixelmaps.org/api/clipstats?day=${iso}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    return {
      clips: Number(d.totalClips || 0),
      pages: Number(d.totalPages || 0),
      top: (d.clips || []).slice(0, 3)
    };
  } catch (_) { return null; }
}

function buildPrompt(dateObj) {
  const memory = usedIdeas();
  return `Du bist der leitende Social-Media-Marketing-Agent von PixelMaps (${SITE}). Tagesdatum: ${dateObj.iso} (${dateObj.weekday}, Kalenderwoche ${dateObj.week}).

PRODUKT: Eine interaktive Weltkarte mit 1 Milliarde Pixel-Kacheln. Man kann einen freien geografischen Punkt für 1 € (ca. 1 $ / 1 £) dauerhaft sichern und erhält eine personalisierte Urkunde. Jeder Pixel wird mit Name + optionalem Emoji markiert. Das ist ein globales Kunst-/Community-Projekt (David-holt: "Ein Stück Weltkarte gehört dir").

BEREITS VERWENDETE IDEEN (nicht wiederholen; suche heute eine NEUE, andere Richtung):
${memory.map((m) => "- " + m).join("\n")}

DEINE AUFGABE HEUTE:
1. Entwickle 3 NEUE, konkrete Marketing-Ideen (je eine Fokusrichtung: TikTok, Instagram, YouTube Shorts). Sie muessen sich von den typischen "Klicksammel"-Videos unterscheiden und zur Karte bezogen sein (Spiel, Story, Fakt, Empathie, Trend).
2. Erstelle daraus je Plattform genau EINEN fertigen Beitrag:
   - TikTok: Hook (max. 8 Worte), Script in Sequenzen (max. 30 Sek, je Sequenz eine Kamerabewegung/Element auf der Karte), Caption mit Hashtags DE+EN, passender Audio-/Soundtrend-Vorschlag (Stichwort, kein realer Songtitel).
   - Instagram: Hook/Cover-Text, 3-5 Carousel-Slides mit jeweils Ueberschrift + 1-2 Saetzen + Bildbeschreibung, Caption, Hashtags DE+EN, CTA.
   - YouTube Shorts: Titel (max. 45 Zeichen), Script (max. 55 Sek), Ending-Frage als Engagement-Hook, Tags, CTA.
3. QUALITAETSREGELN FUER HOOKS UND TITEL (streng, entscheidet uber Klick oder Skip):
   - Jeder Hook/Titel muss konkret und verstaendlich sein (Sprachniveau: 14 Jahre), visuell denken (Was sieht man auf der Karte?).
   - Max. Langen: TikTok-Hook max. 35 Zeichen, Instagram-Hook max. 45 Zeichen, YouTube-Titel max. 40 Zeichen. Kurze Woerter.
   - VERBOTEN: abstrakte Metaphern (z.B. "Kreuzfahrten des Bewusstwerdens", "Globale Geschichten"), gestelztes "Entdecken Sie..." oder "Erleben Sie...", Clickbait-Gehabe, erfundene Zahlen.
   - STATTDESSEN: konkrete Botschaften wie "Dein Stueck Weltkarte fehlt noch", "Wie ich meinen Pixel auf der Karte finde", "1 Randort, 1 Neugierige Frage", "Wer hat Punkt 34.89°/-118.41° gekauft?"
   - Format: Wenige klare Worte, idealerweise Frage oder Ich-Erzaehlung. 3 Beispiele oben sind typisch, keine Vorgabe.
4. Verboten: erfundene Verkaufszahlen, konkrete reale Benutzerzahlen, Preise erhalten, irrefuehrende Behauptungen. Fokus auf Fantasie, Karte, Community, Nachhaltigkeit (gemeinsames Welterbe), kein Clickbait. NIEMALS Kennzahlen erfinden; wo du keine Daten hast, schreibe "unbekannt".
5. Sprache: Beitraege auf Deutsch, Hashtags gemischt DE/EN. Call to Action immer: "${SITE}".
6. ZUSAETZLICH je Beitrag:
   - text_en: Kurze englische Fassung (Hook + Caption + CTA) fuer internationale Kanäle.
   - variants: Je 2 unterschiedliche Einstiege (hook) und 2 Handlungsaufforderungen (cta) zum Testen. CTA-Varianten bleiben sachlich (Domain ${SITE}, Preis 1 €), KEINE erfundenen Behauptungen.
7. suggestions: Genau 3 Vorschlaege fuer die naechsten Inhalte (dayOffset 1, 2, 3) – je ein Post-Titel pro Tag plus Begruendung. Keine erfundenen Daten.

Antworte NUR mit gueltigem JSON, exakt diesem Schema (keine zusaetzlichen Felder, kein Markdown, keine Kommentare):
{
  "date": "${dateObj.iso}",
  "ideas": [
    {"id":"TI-01","title":"Kurzer Erfindungstitel","description":"Idee in max. 2 Saetzen","target":"TikTok"},
    {"id":"IG-01","title":"...","description":"...","target":"Instagram"},
    {"id":"YT-01","title":"...","description":"...","target":"YouTubeShorts"}
  ],
  "posts": [
    {
      "platform":"TikTok","ideaId":"TI-01","hook":"...","script":[{"t":"0-3s","content":"..."},{"t":"3-12s","content":"..."}],
      "caption":"...","hashtags":["#...","#..."],"audio":"...","cta":"${SITE}",
      "text_en":"English version",
      "variants":{"hook":["Einstieg A","Einstieg B"],"cta":["${SITE}","Sichere deinen Pixel: ${SITE}"]}
    },
    {
      "platform":"Instagram","ideaId":"IG-01","hook":"...","slides":[{"title":"...","text":"...","visual":"..."}],
      "caption":"...","hashtags":["#..."],"cta":"${SITE}",
      "text_en":"English version",
      "variants":{"hook":["Einstieg A","Einstieg B"],"cta":["${SITE}","Sichere deinen Pixel: ${SITE}"]}
    },
    {
      "platform":"YouTubeShorts","ideaId":"YT-01","hook":"...","title":"...","script":[{"t":"0-5s","content":"..."}],
      "endingQuestion":"...","tags":["..."],"caption":"...","cta":"${SITE}",
      "text_en":"English version",
      "variants":{"hook":["Einstieg A","Einstieg B"],"cta":["${SITE}","Sichere deinen Pixel: ${SITE}"]}
    }
  ],
  "suggestions": [
    {"dayOffset":1,"platform":"TikTok","title":"...","reason":"..."},
    {"dayOffset":2,"platform":"Instagram","title":"...","reason":"..."},
    {"dayOffset":3,"platform":"YouTubeShorts","title":"...","reason":"..."}
  ]
}`;
}

async function generate(prompt) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, format: "json", options: { temperature: 0.85, num_ctx: 4096 } })
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = String(data.response || "").trim();
  const clean = raw.replace(/^```json\s*/i, "").replace(/\s*```$/m, "").trim();
  return JSON.parse(clean);
}

// Zweiter, separater Aufruf: Uebersetzungen (en/es/fr/it/pt/tr) fuer Hook/Caption/CTA.
// Schlaegt er fehl, bleiben die Beitraege nur auf Deutsch und es wird NICHT erfunden.
function buildTranslationsPrompt(posts) {
  const items = (posts || []).map((p) => {
    const fields = ["hook", "caption", "cta"].filter((k) => p[k]).map((k) => `"${k}": "${esc(p[k])}"`);
    return `{"platform":"${esc(p.platform)}","ideaId":"${esc(p.ideaId)}",${fields.join(",")}}`;
  }).join(",\n");
  return `Uebersetze diese Social-Media-Post-Texte von PixelMaps (interaktive Weltkarte, man kann einen Pixel dauerhaft fuer 1 Euro sichern) 1:1 inhaltlich. 
Regeln: Ton kurz halten, gleiche Botschaft, Nummern nur uebernehmen wenn im deutschen Text vorhanden, KEINE neuen Behauptungen, KEINE erfundenen Kennzahlen. CTA = Domain "pixelmaps.org" (ggf. kurzer sachlicher Zusatz).
Deutscher Ausgangstext:
[
${items}
]
Antworte NUR mit gueltigem JSON ohne Markdown:
{"posts":[
  {"platform":"...","ideaId":"...","translations":{"en":{"hook":"...","caption":"...","cta":"..."},"es":{...},"fr":{...},"it":{...},"pt":{...},"tr":{...}}}
]}
Fuer jeden Post: Sprachen en, es, fr, it, pt, tr. "cta" immer die Domain pixelmaps.org inklusive.`;
}

async function generateTranslations(posts) {
  const prompt = buildTranslationsPrompt(posts);
  const data = await generate(prompt);
  const byId = {};
  for (const row of data.posts || []) if (row.ideaId && row.translations) byId[row.ideaId] = row.translations;
  let merged = 0;
  for (const post of posts || []) {
    const t = byId[post.ideaId];
    if (t) { post.translations = t; merged++; }
  }
  return { merged, total: (posts || []).length };
}

function applyIntlHints(parsed, hints){
  if(!hints || !Array.isArray(hints.winners)) return;
  const winByIdea = {};
  for(const w of hints.winners){ if(w.ideaId) winByIdea[w.ideaId]=w; }
  const locByIdea = {};
  if(Array.isArray(hints.localized)){
    for(const l of hints.localized){ if(l.ideaId) locByIdea[l.ideaId]=l; }
  }
  for(const post of parsed.posts||[]){
    const w = winByIdea[post.ideaId];
    if(w && w.hook && (!post.hook || post.hook.length>40)){
      post.hook = w.hook;
      if(post.variants && Array.isArray(post.variants.hook)) post.variants.hook[0]=w.hook;
    }
    const l = locByIdea[post.ideaId];
    if(l){
      if(!post.translations) post.translations={};
      post.translations.en = post.translations.en || {hook:l.en, caption:post.text_en||post.caption||"", cta:"pixelmaps.org"};
      if(l.es) post.translations.es = post.translations.es || {hook:l.es, caption:"", cta:"pixelmaps.org"};
      if(l.fr) post.translations.fr = post.translations.fr || {hook:l.fr, caption:"", cta:"pixelmaps.org"};
      if(l.it) post.translations.it = post.translations.it || {hook:l.it, caption:"", cta:"pixelmaps.org"};
      if(l.pt) post.translations.pt = post.translations.pt || {hook:l.pt, caption:"", cta:"pixelmaps.org"};
      if(l.tr) post.translations.tr = post.translations.tr || {hook:l.tr, caption:"", cta:"pixelmaps.org"};
      if(l.en && !post.text_en) post.text_en = l.en + (post.caption? " "+post.caption:"");
    }
  }
  if(typeof hints.remaining === 'number' && hints.remaining < 10000000){
    for(const post of parsed.posts||[]){
      if(post.hook && !/frei|left/i.test(post.hook) && post.hook.length < 35){
        // nur anhängen wenn Platz bleibt
      }
    }
  }
}

  // Tageszusammenfassung + laufendes Publikations-Log. Kennzahlen nur mit Quelle;
// fehlende Werte werden ausdruecklich als "unbekannt" markiert (nichts erfinden).
function writeSummary(dateObj, parsed, metrics) {
  const dir = path.join(CONTENT, "reports", String(dateObj.year), dateObj.month);
  fs.mkdirSync(dir, { recursive: true });
  const reviewDir = path.join(CONTENT, "review");
  fs.mkdirSync(reviewDir, { recursive: true });

  const L = [];
  L.push(`# PixelMaps Tageszusammenfassung — ${dateObj.iso} (${dateObj.weekday}, KW ${dateObj.week})`);
  L.push("");
  L.push(`Erstellt: ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`);
  L.push("");
  L.push("## Ideen (heute neu entwickelt)");
  for (const i of parsed.ideas || []) L.push(`- **${i.id}** (${i.target}): ${i.title} — ${i.description}`);
  L.push("");
  L.push("## Beiträge (zur Veröffentlichung vorgesehen)");
  for (const post of parsed.posts || []) {
    const buf = post._buffer
      ? (post._buffer.ok ? `Buffer OK (${post._buffer.id})` : `Buffer: ${post._buffer.reason}`)
      : "Push noch offen (publish-day 09:10)";
    const lang = post.translations ? Object.keys(post.translations).join(", ") : "nur DE";
    L.push(`- **${post.platform}** [${post.ideaId}] „${post.hook || post.title}“`);
    L.push(`  - EN-Text: ${fmtKnown(post.text_en ? "ja" : "")} · Übersetzungen: ${fmtKnown(lang)}`);
    if (post.variants) {
      L.push(`  - Hook-Varianten: ${(post.variants.hook || []).map((h) => `„${h}“`).join("  vs.  ")}`);
      L.push(`  - CTA-Varianten: ${(post.variants.cta || []).map((c) => `„${c}“`).join("  vs.  ")}`);
    }
    L.push(`  - Status: ${buf}`);
  }
  L.push("");
  L.push("## Kennzahlen (nur mit nachvollziehbarer Quelle; ohne Quelle = unbekannt)");
  L.push(`- Videoaufrufe eigene Auslieferung (pixelmaps.org/clipstats, Stand Erstellung): ${fmtKnown(metrics ? metrics.clips : null)}`);
  L.push(`- Seitenabrufe (pixelmaps.org): ${fmtKnown(metrics ? metrics.pages : null)}`);
  L.push(`- YouTube Views/Likes/Kommentare: unbekannt (nur mit YouTube-API-Key, siehe marketing-report.js)`);
  L.push(`- TikTok/Instagram Reichweite/Engagement: unbekannt (Business-Konto + API-Zugriff nötig)`);
  L.push(`- Checkout-Starts/Käufe/Umsatz: unbekannt (Stripe-Live-Key fehlt, siehe marketing-report.js)`);
  L.push("");
  L.push("> Regel: Es werden ausschließlich Kennzahlen mit belegbarer Quelle aufgeführt. Alles ohne Zugriff wird ausdrücklich als \`unbekannt\` geführt — es wird nichts erfunden.");
  L.push("");
  L.push("## Vorschläge für die nächsten Inhalte");
  for (const s of parsed.suggestions || []) L.push(`- **Tag +${fmtKnown(s.dayOffset)}** (${s.platform}): ${s.title} — ${s.reason}`);
  L.push("");
  const file = path.join(dir, `${dateObj.iso}-summary.md`);
  fs.writeFileSync(file, L.join("\n"));
  logMsg("Datei: " + file);

  const logFile = path.join(reviewDir, "publish-log.md");
  const prev = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "# PixelMaps Publikations-Log\n\n";
  const E = [];
  E.push(`## ${dateObj.iso}`);
  for (const post of parsed.posts || []) {
    const buf = post._buffer ? (post._buffer.ok ? `OK (${post._buffer.id})` : post._buffer.reason) : "Push ausstehend (publish-day 09:10)";
    E.push(`- ${post.platform} [${post.ideaId}] „${post.hook || post.title}“ — Buffer: ${buf}`);
  }
  E.push(`- Kennzahlen: Clips=${fmtKnown(metrics ? metrics.clips : null)}, Seiten=${fmtKnown(metrics ? metrics.pages : null)}; Details: reports/${dateObj.month}/${dateObj.iso}-summary.md`);
  fs.writeFileSync(logFile, prev + E.join("\n") + "\n");
  logMsg("Datei: " + logFile);
  return file;
}

const GRAPHQL_URL = "https://api.buffer.com";

async function bufferGraphQL(query, variables) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + BUFFER_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, reason: `Buffer HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}` };
  return { ok: true, data };
}

const BUFFER_ORG = CFG.bufferOrgId || "6aafe8c03cf501260e7e406c";

// Buffer ordnet "addToQueue"-Posts selbst einen Slot zu. Dabei kann ein
// bereits fest geplanter Campaign-Post am selben Tag liegen -> zwei Posts
// pro Tag. Darum vor dem Push einen freien Tag suchen und fest planen.
// Buffer liefert max. 10 Posts pro Abfrage; deshalb Zeitfenster.
async function scheduledDays(channelId, horizonDays = 14) {
  const out = new Set();
  const now = Date.now();
  const end = now + horizonDays * 864e5;
  let okCount = 0;
  const q = `query($o:OrganizationId!,$f:PostsFiltersInput!){posts(input:{organizationId:$o,filter:$f,sort:[{field:dueAt,direction:asc}]}){edges{node{id dueAt status}}}}`;
  for (let t = now - 2 * 864e5; t < end; t += 4 * 864e5) {
    const e = Math.min(t + 4 * 864e5, end);
    const f = { channelIds: [channelId], status: ["scheduled"], dueAt: { start: new Date(t).toISOString(), end: new Date(e).toISOString() } };
    const r = await bufferGraphQL(q, { o: BUFFER_ORG, f });
    if (!r.ok) continue;
    okCount++;
    const edges = (((r.data || {}).data || {}).posts || {}).edges || [];
    for (const edge of edges) if (edge.node && edge.node.dueAt) out.add(String(edge.node.dueAt).slice(0, 10));
  }
  // Keine einzige Abfrage erfolgreich -> lieber null (dann addToQueue) als
  // versehentlich einen belegten Tag als frei anzusehen.
  return okCount ? out : null;
}

async function nextFreeDay(channelId, horizonDays = 14) {
  const taken = await scheduledDays(channelId, horizonDays);
  if (!taken) return null;
  const now = Date.now();
  for (let i = 1; i <= horizonDays; i++) {
    const day = new Date(now + i * 864e5).toISOString().slice(0, 10);
    if (!taken.has(day)) return day;
  }
  return null;
}

async function listChannels() {
  if (!BUFFER_TOKEN) throw new Error("BUFFER_ACCESS_TOKEN nicht gesetzt (config.json)");
  const acc = await bufferGraphQL(`{ account { id organizations { id name } } }`);
  if (!acc.ok) throw new Error(acc.reason);
  const orgs = acc.data.data.account.organizations || [];
  const out = [];
  for (const org of orgs) {
    const r = await bufferGraphQL(`{ channels(input: { organizationId: "${org.id}" }) { id name type service } }`);
    if (r.ok) out.push(...(r.data.data.channels || []));
  }
  console.log(JSON.stringify(out, null, 2));
  if (!out.length) console.log("KEINE Kanäle gefunden. Doku: https://developers.buffer.com");
}

function generatedClipUrl(platform) {
  return "https://pixelmaps.org/clips/generated/" + today().iso + "-" + platform + ".mp4";
}

async function hasClip(url) {
  try {
    const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch { return false; }
}

async function genVideo(prompt) {
  if (!CFG.pollinationsKey) return null;
  const model = (CFG.ai && CFG.ai.videoModel) || "nova-reel";
  const duration = (CFG.ai && CFG.ai.videoDuration) || 6;
  const url = "https://gen.pollinations.ai/video/" + encodeURIComponent((CFG.ai && CFG.ai.style ? CFG.ai.style + ", " : "") + prompt)
    + "?aspectRatio=9:16&model=" + encodeURIComponent(model) + "&duration=" + duration + "&key=" + CFG.pollinationsKey;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 165000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
    if (!res.ok) { logMsg("KI-Video HTTP " + res.status + ": " + (await res.text()).slice(0, 200)); return null; }
    const bytes = (await res.arrayBuffer()).byteLength;
    if (!bytes) return null;
    logMsg("KI-Video erzeugt (" + Math.round(bytes / 1024) + " KB): " + prompt.slice(0, 40));
    return url;
  } catch (e) {
    logMsg("KI-Video fehlgeschlagen: " + e.message);
    return null;
  } finally { clearTimeout(t); }
}

async function genImage(prompt) {
  const style = (CFG.ai && CFG.ai.style) || "vertical pixel-art world map, glowing teal neon on dark navy, cinematic";
  const url = "https://image.pollinations.ai/prompt/" + encodeURIComponent(style + ", " + prompt) + "?width=1080&height=1920&nologo=true";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
    if (!res.ok) return null;
    const bytes = (await res.arrayBuffer()).byteLength;
    if (!bytes) return null;
    logMsg("KI-Bild erzeugt (" + Math.round(bytes / 1024) + " KB): " + prompt.slice(0, 40));
    return url;
  } catch (e) {
    logMsg("KI-Bild fehlgeschlagen: " + e.message);
    return null;
  } finally { clearTimeout(t); }
}

async function bufferPush(post, mode) {
  if (!BUFFER_TOKEN) return { ok: false, reason: "review-only (BUFFER_ACCESS_TOKEN nicht gesetzt)" };
  const channelId = BUFFER_CHANNELS[post.platform] || BUFFER_CHANNELS.TikTok;
  if (!channelId) return { ok: false, reason: "kein Buffer-Kanal fuer " + post.platform + " (bufferChannels in config.json)" };
  const text = (() => {
    // Das KI-JSON liefert nicht immer alle Felder — ohne Guard landete
    // "undefined" im Beitragstext.
    const head = [post.hook, post.caption].map((s) => String(s == null ? "" : s).trim()).filter(Boolean).join(" ");
    const cta = String(post.cta == null ? "" : post.cta).trim();
    return head + (cta ? `\n\n${cta}` : "");
  })();
  const input = {
    text,
    channelId,
    schedulingType: post.platform === "Instagram" ? "notification" : "automatic",
    mode: mode || "addToQueue",
    assets: []
  };
  if (post.platform === "TikTok") {
    const genClip = await hasClip(generatedClipUrl("TikTok"));
    if (genClip) {
      input.assets = [{ video: { url: generatedClipUrl("TikTok"), metadata: { title: String(post.title || post.hook || text).slice(0, 100) } } }];
      input.metadata = { tiktok: { title: String(post.title || post.hook || text).slice(0, 100) } };
      input.schedulingType = "automatic";
    } else {
      const usesAiImages = CFG.ai && CFG.ai.images !== false;
      const img = usesAiImages ? await genImage(post.hook || post.caption || text) : null;
      if (img) {
        input.assets = [{ image: { url: img } }];
        input.metadata = { tiktok: { title: String(post.title || post.hook || text).slice(0, 100) } };
        input.schedulingType = "automatic";
      } else {
        const tt = CFG.tiktok || {};
        const urls = []
          .concat(tt.videoUrls || [])
          .concat(tt.videoUrl ? [tt.videoUrl] : [])
          .concat(CFG.youtube && CFG.youtube.videoUrl ? [CFG.youtube.videoUrl] : []);
        if (!urls.length) return { ok: false, reason: "TikTok braucht Video: config.json → tiktok.videoUrl(s) (oeffentliche MP4-URL)" };
        const url = urls[(new Date().getDate() - 1) % urls.length];
        const title = String(post.title || post.hook || text).slice(0, 100);
        input.metadata = { tiktok: { title } };
        input.assets = [{ video: { url, metadata: { title } } }];
      }
    }
  }
  if (post.platform === "Instagram") {
    const cfgReel = CFG.instagram && CFG.instagram.reelVideoUrl;
    const cfgFallback = CFG.instagram && CFG.instagram.reelFallbackUrl;
    const cfgImage = CFG.instagram && CFG.instagram.imageUrl;
    // Das tagesdatierte Reel existiert nur, wenn die KI-Video-Erzeugung
    // geklappt hat. Sonst auf ein dauerhaft vorhandenes Reel ausweichen,
    // statt den Push mit einer toten URL zu verlieren.
    let reel = null;
    if (cfgReel && await hasClip(cfgReel)) reel = cfgReel;
    else if (cfgFallback && await hasClip(cfgFallback)) reel = cfgFallback;
    if (reel) {
      input.metadata = { instagram: { type: "reel", shouldShareToFeed: true } };
      input.assets = [{ video: { url: reel, metadata: { title: String(post.hook || post.caption || text).slice(0, 100) } } }];
    } else {
      const img = cfgImage ? null : await genImage(post.hook || post.caption || text);
      const imageUrl = cfgImage || img;
      if (!imageUrl) return { ok: false, reason: "Instagram braucht Bild: config.json → instagram.imageUrl" };
      input.metadata = { instagram: { type: "post", shouldShareToFeed: true } };
      input.assets = [{ image: { url: imageUrl } }];
    }
  }
  if (post.platform === "YouTubeShorts") {
    const yt = CFG.youtube || {};
    const genClip = await hasClip(generatedClipUrl("YouTubeShorts"));
    let videoUrl = null;
    if (genClip) videoUrl = generatedClipUrl("YouTubeShorts");
    else {
      const usesAiVideo = CFG.pollinationsKey && CFG.ai && CFG.ai.video !== false;
      videoUrl = usesAiVideo ? await genVideo(post.hook || post.caption || text) : null;
    }
    if (!videoUrl) {
      // Rotation ueber die dauerhaft vorhandenen Clips, sonst gibt es jeden
      // Tag denselben Intro-Card.
      const list = (yt.videoUrls && yt.videoUrls.length) ? yt.videoUrls : (yt.videoUrl ? [yt.videoUrl] : []);
      if (list.length) videoUrl = list[(new Date().getDate() - 1) % list.length];
    }
    if (!videoUrl) return { ok: false, reason: "YouTube braucht Video: config.json → youtube.videoUrl" };
    const title = String(yt.title || post.title || post.hook || text).slice(0, 100);
    input.metadata = { youtube: { title, categoryId: yt.categoryId || "22", privacy: yt.privacy || "unlisted" } };
    input.assets = [{ video: { url: videoUrl, metadata: { title } } }];
  }
  // Fest auf einen freien Tag planen statt Buffer den Slot waehlen zu lassen.
  try {
    const freeDay = await nextFreeDay(channelId, 14);
    if (freeDay) {
      const time = post.platform === "Instagram" ? "16:30:00" : post.platform === "YouTubeShorts" ? "16:15:00" : "16:00:00";
      input.mode = "customScheduled";
      input.dueAt = `${freeDay}T${time}Z`;
    }
  } catch (e) {
    logMsg("Freier Tag nicht ermittelbar, nutze addToQueue: " + e.message);
  }
  const result = await bufferGraphQL(
    `mutation($input: CreatePostInput!) {
       createPost(input: $input) {
         ... on PostActionSuccess { post { id text status } }
         ... on MutationError { message }
       }
     }`,
    { input }
  );
  if (!result.ok) return result;
  const data = result.data && result.data.data ? result.data.data.createPost : null;
  if (data && data.message) return { ok: false, reason: data.message };
  if (data && data.post) return { ok: true, id: data.post.id };
  return { ok: false, reason: "unbekannte Buffer-Antwort: " + JSON.stringify(data).slice(0, 200) };
}

async function writeFiles(dateObj, parsed) {
  const dayDir = path.join(CONTENT, String(dateObj.year), dateObj.month, dateObj.iso);
  fs.mkdirSync(dayDir, { recursive: true });
  const reviewDir = path.join(CONTENT, "review");
  fs.mkdirSync(reviewDir, { recursive: true });

  const postsFile = path.join(dayDir, "posts.json");
  fs.writeFileSync(postsFile, JSON.stringify(parsed, null, 2) + "\n");
  logMsg("Datei: " + postsFile);

  // Review-Blatt
  const md = [];
  md.push(`# PixelMaps Marketing — ${dateObj.iso} (${dateObj.weekday}, KW ${dateObj.week})`);
  md.push("");
  md.push("## Ideen");
  for (const idea of parsed.ideas || []) md.push(`- **${idea.id}** (${idea.target}): ${idea.title} — ${idea.description}`);
  md.push("");
  md.push("## Beiträge zur Freigabe");
  for (const post of parsed.posts || []) {
    const buf = post._buffer ? (post._buffer.ok ? `Buffer OK (${post._buffer.id})` : `Buffer ${post._buffer.reason}`) : "review-only";
    md.push(`### ${post.platform} — ${post.ideaId}`);
    md.push(`- Hook/Title: **${post.hook || post.title}**`);
    if (Array.isArray(post.script)) for (const s of post.script) md.push(`- [${s.t}] ${s.content}`);
    if (Array.isArray(post.slides)) for (const s of post.slides) md.push(`- Slide "${s.title}": ${s.text} (Visuell: ${s.visual})`);
    if (post.endingQuestion) md.push(`- Endfrage: ${post.endingQuestion}`);
    if (post.audio) md.push(`- Audio-Style: ${post.audio}`);
    md.push(`- Caption: ${post.caption}`);
    md.push(`- Hashtags: ${(post.hashtags || []).join(" ")}`);
    if (post.text_en) md.push(`- EN-Text: ${post.text_en}`);
    if (post.variants) md.push(`- Hook-Varianten: ${(post.variants.hook || []).join("  |  ")} · CTA-Varianten: ${(post.variants.cta || []).join("  |  ")}`);
    if (post.translations) md.push(`- Übersetzungen: ${Object.keys(post.translations).join(", ")}`);
    md.push(`- Buffer: ${buf}`);
    md.push("- Status: **zur Freigabe**");
    md.push("");
  }
  if (parsed.suggestions && parsed.suggestions.length) {
    md.push("## Vorschläge für die nächsten Inhalte");
    for (const s of parsed.suggestions) md.push(`- **Tag +${s.dayOffset}** (${s.platform}): ${s.title} — ${s.reason}`);
    md.push("");
  }
  const reviewFile = path.join(reviewDir, `${dateObj.iso}-posts.md`);
  fs.writeFileSync(reviewFile, md.join("\n"));
  logMsg("Datei: " + reviewFile);

  // Wochenplan (aggregiert alle Beitraege der aktuellen Kalenderwoche)
  const weekItems = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "posts.json") {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        if (isoWeek(new Date(data.date + "T12:00:00")) === dateObj.week) weekItems.push(data);
      }
    }
  };
  if (fs.existsSync(CONTENT)) walk(CONTENT);
  weekItems.sort((a, b) => a.date.localeCompare(b.date));

  const wmd = [];
  wmd.push(`# PixelMaps Wochenplan — KW ${dateObj.week} (${dateObj.year})`);
  wmd.push("");
  wmd.push(`Aktualisiert: ${dateObj.iso}`);
  wmd.push("");
  wmd.push(`Verfuegbare Beitragstage: ${weekItems.length}`);
  wmd.push("");
  for (const d of weekItems) {
    wmd.push(`## ${d.date}`);
    for (const post of d.posts || []) {
      wmd.push(`- ${post.platform} [${post.ideaId}] ${post.hook || post.title} — Buffer: ${post._buffer ? (post._buffer.ok ? "OK" : post._buffer.reason) : "review-only"}`);
    }
  }
  wmd.push("");
  wmd.push("Status: Beitraege liegen im Ordner `review/` zur Freigabe. Buffer-Update folgt nach Freigabe.");
  const weekFile = path.join(CONTENT, "review", `WEEK-PLAN-KW${dateObj.week}-${dateObj.year}.md`);
  fs.writeFileSync(weekFile, wmd.join("\n"));
  logMsg("Datei: " + weekFile);
  return { postsFile, reviewFile, weekFile };
}

async function pushDay(iso) {
  const dayDir = path.join(CONTENT, String(new Date(iso).getFullYear()), String(Number(iso.slice(5, 7))).padStart(2, "0"), iso);
  const file = path.join(dayDir, "posts.json");
  if (!fs.existsSync(file)) throw new Error("Kein posts.json fuer " + iso + " (" + file + "). Zuerst normal generieren.");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  let pushed = 0, skipped = 0;
  for (const post of data.posts || []) {
    if (post._buffer && post._buffer.ok) { skipped++; continue; }
    const res = await bufferPush(post);
    post._buffer = res;
    if (res.ok) pushed++; else logMsg("Push " + post.platform + " fehlgeschlagen: " + res.reason);
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  const reviewFile = path.join(CONTENT, "review", iso + "-posts.md");
  if (fs.existsSync(reviewFile)) fs.appendFileSync(reviewFile, `\n\n> ${new Date().toISOString()} — manueller Push: ${pushed} neu gepusht, ${skipped} bereits gepusht (Buffer: Queue, automatische Veröffentlichung).\n`);
  console.log(JSON.stringify({ ok: true, date: iso, pushed, skipped, buffer: data.posts.map(p => ({ platform: p.platform, ok: p._buffer.ok, reason: p._buffer.reason })) }, null, 2));
}

// Test-Fixtures: --stub durchlaeuft den kompletten Pfad (writeFiles, Summary, Log)
// ohne Ollama; schreibt nur in AGENT_CONTENT/AGENT_BASE.
function stubParsed(dateObj) {
  const p = (platform, ideaId, hook, caption) => ({
    platform, ideaId, hook, caption,
    hashtags: ["#PixelMaps", "#Weltkarte"],
    cta: "pixelmaps.org",
    text_en: "English stub for " + hook,
    variants: { hook: ["Variant A: " + hook, "Variant B: " + hook], cta: ["pixelmaps.org", "Sichere deinen Pixel: pixelmaps.org"] },
    translations: { en: { hook, caption, cta: "pixelmaps.org" } }
  });
  return {
    date: dateObj.iso,
    ideas: [
      { id: "TI-01", title: "Stub-Idee TikTok", description: "Testbeschreibung 1", target: "TikTok" },
      { id: "IG-01", title: "Stub-Idee Instagram", description: "Testbeschreibung 2", target: "Instagram" },
      { id: "YT-01", title: "Stub-Idee YouTube", description: "Testbeschreibung 3", target: "YouTubeShorts" }
    ],
    posts: [
      p("TikTok", "TI-01", "Stub Hook TikTok", "Stub Caption TikTok"),
      p("Instagram", "IG-01", "Stub Hook Instagram", "Stub Caption Instagram"),
      p("YouTubeShorts", "YT-01", "Stub Hook YouTube", "Stub Caption YouTube")
    ],
    suggestions: [
      { dayOffset: 1, platform: "TikTok", title: "Stub Vorschlag 1", reason: "Testgrund 1" },
      { dayOffset: 2, platform: "Instagram", title: "Stub Vorschlag 2", reason: "Testgrund 2" },
      { dayOffset: 3, platform: "YouTubeShorts", title: "Stub Vorschlag 3", reason: "Testgrund 3" }
    ]
  };
}

async function main() {
  if (process.argv.includes("--channels")) {
    try { await listChannels(); } catch (e) { console.error(e.message); process.exit(1); }
    return;
  }
  const pi = process.argv.indexOf("--push");
  if (pi !== -1) {
    const iso = process.argv[pi + 1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) { console.error("Nutzung: agent.js --push YYYY-MM-DD"); process.exit(1); }
    try { await pushDay(iso); } catch (e) { console.error(e.message); process.exit(1); }
    return;
  }
  const dateObj = today();
  const stub = process.argv.includes("--stub");
  const hints = loadOrchestratorHints();
  if(hints){ logMsg("Orchestrator-Hints geladen: "+(hints.winners||[]).length+" Gewinner, remaining: "+hints.remaining); }
  logMsg(`Agent-Start ${dateObj.iso}, KW${dateObj.week}, Modell ${MODEL}${stub ? " (STUB-Modus)" : ""}`);
  try {
    const prompt = buildPrompt(dateObj);
    let parsed;
    let translations;
    if (stub) {
      parsed = stubParsed(dateObj);
      translations = { merged: 3, total: 3 };
      logMsg("STUB: Fixture verwendet (kein Ollama)");
    } else {
      logMsg("Generiere via Ollama ...");
      parsed = await generate(prompt);
      if (!Array.isArray(parsed.posts) || !Array.isArray(parsed.ideas)) throw new Error("Unerwartete Antwortstruktur von Ollama");
      try {
        translations = await generateTranslations(parsed.posts);
        logMsg("Uebersetzungen: " + translations.merged + "/" + translations.total + " Beitraege");
      } catch (e) {
        translations = { merged: 0, total: (parsed.posts || []).length, error: e.message };
        logMsg("Uebersetzungen fehlgeschlagen (Beitraege bleiben DE, nichts erfunden): " + e.message);
      }
    }

    applyIntlHints(parsed, hints);

    for (const post of parsed.posts) {
      if (post.cta) post.cta = withUtm(post.cta, post, dateObj.iso);
      if (process.env.AGENT_PUSH === "1") post._buffer = await bufferPush(post);
    }
    const { postsFile, reviewFile, weekFile } = await writeFiles(dateObj, parsed);
    const metrics = await dayMetrics(dateObj.iso).catch(() => null);
    const summaryFile = writeSummary(dateObj, parsed, metrics);
    logMsg("FERTIG. Belege: posts.json, review-MD, Wochenplan-MD, Tageszusammenfassung-MD");
    console.log(JSON.stringify({
      ok: true, date: dateObj.iso, posts: parsed.posts.length, postsFile, reviewFile, weekFile, summaryFile,
      translations, metrics,
      buffer: parsed.posts.map(p => p._buffer)
    }, null, 2));
  } catch (e) {
    logMsg("FEHLER: " + e.stack || e.message);
    fs.mkdirSync(path.join(CONTENT, "review"), { recursive: true });
    fs.appendFileSync(path.join(CONTENT, "review", "agent.log"), log.join("\n") + "\n", "utf8");
    console.error(JSON.stringify({ ok: false, date: dateObj.iso, error: e.message }));
    process.exit(1);
  }
}

module.exports = { bufferPush, genImage, genVideo, listChannels, pushDay, CFG, CONTENT, today, buildPrompt, generateTranslations, writeSummary, stubParsed, dayMetrics, usedIdeas, scheduledDays, nextFreeDay };
if (require.main === module) main();