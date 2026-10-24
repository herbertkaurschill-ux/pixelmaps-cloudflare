#!/usr/bin/env node
// Buffer-Queue inspizieren: alle geplanten Posts je Kanal.
// Die GraphQL-API liefert max. 10 Eintraege pro Abfrage, deshalb wird
// zeitraumweise gefiltert (filter.dueAt.start/end).
const path = require("path");
const os = require("os");
const CFG = require(path.join(os.homedir(), ".n8n", "agent", "config.json"));
const H = { Authorization: "Bearer " + CFG.bufferAccessToken, "Content-Type": "application/json" };
const ORG = process.env.BUFFER_ORG || "6aafe8c03cf501260e7e406c";
const CH = CFG.bufferChannels || {};

async function gql(q, v) {
  const r = await fetch("https://api.buffer.com", { method: "POST", headers: H, body: JSON.stringify({ query: q, variables: v }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

const Q = `query($o:OrganizationId!,$f:PostsFiltersInput!){posts(input:{organizationId:$o,filter:$f,sort:[{field:dueAt,direction:asc}]}){edges{node{id dueAt status channelService text assets{... on Asset{type source}}}}}}`;

async function scheduledFor(channelId, start, end) {
  const out = [];
  const f = { channelIds: [channelId], status: ["scheduled"], dueAt: { start, end } };
  const d = await gql(Q, { o: ORG, f });
  out.push(...d.posts.edges.map((e) => e.node));
  return out;
}

(async () => {
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 864e5).toISOString();
  const end = new Date(now.getTime() + 90 * 864e5).toISOString();
  const names = Object.entries(CH);
  let total = 0;
  for (const [name, id] of names) {
    const rows = [];
    for (let t = new Date(now.getTime() - 2 * 864e5); t < new Date(now.getTime() + 90 * 864e5); t = new Date(t.getTime() + 9 * 864e5)) {
      const e = new Date(Math.min(t.getTime() + 9 * 864e5, now.getTime() + 90 * 864e5));
      rows.push(...(await scheduledFor(id, t.toISOString(), e.toISOString())));
    }
    const seen = new Set();
    const uniq = rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
    total += uniq.length;
    console.log(`\n## ${name} (${id}) — ${uniq.length} scheduled`);
    uniq.forEach((n) => {
      const a = (n.assets && n.assets[0] && n.assets[0].source) || "-";
      console.log(`  ${n.dueAt.slice(0, 10)} ${a.replace("https://pixelmaps.org", "").replace("https://image.pollinations.ai/prompt/", "POLLI:").slice(0, 92)}`);
    });
  }
  console.log(`\nSUMME scheduled: ${total}`);
})().catch((e) => { console.error("FEHLER:", e.message); process.exit(1); });
