#!/usr/bin/env node
// Repariert geplante Buffer-Posts mit toten Video-URLs.
// Die Posts wurden auf /clips/generated/<tag>-<plattform>.mp4 geplant — diese
// Dateien existieren nur bis 05.10.2026. Statt sie zu loeschen, haengen wir
// ein dauerhaft vorhandenes Campaign-Clip ein (Text bleibt, Zeitplan bleibt).
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const PROJ = "/Users/up/Desktop/pixelmaps-cloudflare";
const { loadClipIndex, pickClip, langOf } = require(path.join(PROJ, "scripts/campaign/clip-index.cjs"));
const CFG = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".n8n/agent/config.json"), "utf8"));
const ORG = CFG.bufferOrgId || "6aafe8c03cf501260e7e406c";
const H = { Authorization: "Bearer " + CFG.bufferAccessToken, "Content-Type": "application/json" };
const gql = async (q, v) => (await fetch("https://api.buffer.com", { method: "POST", headers: H, body: JSON.stringify({ query: q, variables: v }) })).json();

const DEAD_PREFIX = "https://pixelmaps.org/clips/generated/";
const INDEX = loadClipIndex();

// Sprache aus dem Posttext ableiten (Hashtags) oder Default.
const langFromText = (t) => {
  const s = String(t || "");
  if (/[а-яА-Я]/.test(s)) return "ru";
  if (/[ऀ-ॿ]/.test(s)) return "hi";
  if (/[一-鿿]/.test(s)) return "zh";
  if (/[¿¡áéíóúñ]/i.test(s)) return "es";
  if (/[àâçéèêëîïôûùüÿœ]/i.test(s)) return "fr";
  if (/[ãõâêôç]/i.test(s)) return "pt";
  if (/[ğışçö]/i.test(s)) return "tr";
  if (/[àèéìòù]/i.test(s)) return "it";
  return "en";
};

(async () => {
  const q = `query($o: OrganizationId!){ posts(first:100,input:{organizationId:$o}){ edges{ node{ id channelId status dueAt text assets{ id type source } } } } }`;
  const j = await gql(q, { o: ORG });
  const rows = (j.data?.posts?.edges || []).map((e) => e.node);
  const broken = rows.filter((n) => (n.assets || []).some((a) => String(a.source || "").startsWith(DEAD_PREFIX)));
  console.log(`Geplante Posts gesamt: ${rows.length} | mit toten Asset-URLs: ${broken.length}`);
  if (!broken.length) { console.log("Nichts zu reparieren."); return; }

  const used = new Set();
  let fixed = 0;
  for (const n of broken) {
    const lang = langFromText(n.text);
    const clip = pickClip(INDEX, lang, rows.indexOf(n) * 7 + 3, used);
    used.add(clip.id);
    const meta = { video: { url: clip.url, metadata: { title: clip.title } } };
    const r = await gql(
      `mutation($i: EditPostInput!){ editPost(input:$i){ ... on PostActionSuccess{ post{ id status dueAt } } ... on MutationError{ message } } }`,
      { i: { id: n.id, assets: [{ video: { url: clip.url, metadata: { title: clip.title } } }], text: String(n.text || "").replace(/\s*undefined\b/g, "").trim() } }
    );
    const d = r.data?.editPost;
    if (d && d.post) { fixed++; console.log(`OK   ${n.dueAt} ${n.id} -> ${clip.id} (${clip.lang})`); }
    else console.log(`FEHLER ${n.id}: ${d?.message || JSON.stringify(r).slice(0, 200)}`);
    await new Promise((res) => setTimeout(res, 800));
  }
  console.log(`Repariert: ${fixed}/${broken.length}`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
