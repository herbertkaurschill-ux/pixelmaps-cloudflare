#!/usr/bin/env node
// Echte Reichweitendaten von Buffer holen - im Gegensatz zu /api/clipstats,
// das nur HTTP-Requests auf die eigene Website zaehlt.
//
//   node scripts/campaign/insights.mjs            # Gesamtzahlen (30 Tage)
//   node scripts/campaign/insights.mjs --days 7
//   node scripts/campaign/insights.mjs --per-post  # je Post aufgeschluesselt
//   node scripts/campaign/insights.mjs --json > /tmp/insights.json
import fs from "fs";

const CFG = "/Users/up/.n8n/agent/config.json";
const cfg = JSON.parse(fs.readFileSync(CFG, "utf8"));
const H = {
  Authorization: "Bearer " + cfg.bufferAccessToken,
  "Content-Type": "application/json",
};
const ORG = cfg.bufferOrgId || "6aafe8c03cf501260e7e406c";
const CH = cfg.bufferChannels || {};

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : d;
};
const DAYS = parseInt(arg("--days", "30"), 10);
const PER_POST = process.argv.includes("--per-post");
const AS_JSON = process.argv.includes("--json");

async function gq(query, variables) {
  const r = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
  return j.data;
}

const iso = (d) => new Date(d).toISOString();
const start = new Date(Date.now() - (DAYS - 1) * 86400000);
const end = new Date();

const AGG = `query($i: AggregatedPostMetricsInput!) {
  aggregatedPostMetrics(input: $i) {
    metricsUpdatedAt
    metrics { name description type unit value }
  }
}`;

async function totals() {
  const d = await gq(AGG, {
    i: {
      organizationId: ORG,
      channelIds: Object.values(CH),
      startDateTime: iso(start),
      endDateTime: iso(end),
    },
  });
  return d.aggregatedPostMetrics;
}

// PostsInput kennt kein channelIds - nur organizationId und einen Filter.
const POSTS = `query($i: PostsInput!) {
  posts(first: 100, input: $i) {
    edges { node {
      id dueAt status channelId sentAt channelService
      channel { id service }
      metrics { name type unit value }
      metricsUpdatedAt
      text
    } }
  }
}`;

async function perPost() {
  // organizationId genuegt; channelService trennen wir danach selbst.
  const d = await gq(POSTS, { i: { organizationId: ORG } });
  return (d.posts.edges || []).map((e) => e.node);
}

const METRIC_LABEL = {
  views: "Views",
  reactions: "Reaktionen",
  comments: "Kommentare",
  engagementRate: "Engagement %",
  impressions: "Impressionen",
  reach: "Reichweite",
};

function metricOf(node, type) {
  const m = (node.metrics || []).find((x) => x.type === type);
  return m ? m.value : null;
}

(async () => {
  const agg = await totals();
  const byType = Object.fromEntries(
    (agg.metrics || []).map((m) => [m.type, m.value])
  );

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        { days: DAYS, updatedAt: agg.metricsUpdatedAt, totals: byType },
        null,
        2
      )
    );
    return;
  }

  const views = byType.views || 0;
  const reactions = byType.reactions || 0;
  const comments = byType.comments || 0;
  const posts = byType.postCount || 0;

  console.log(`Buffer-Reichweite, letzte ${DAYS} Tage`);
  console.log(`aktualisiert: ${agg.metricsUpdatedAt}\n`);
  for (const m of agg.metrics || []) {
    console.log(`  ${(m.name + "                    ").slice(0, 20)} ${m.value}`);
  }
  console.log(`\n${"-".repeat(46)}`);
  console.log(`Posts gesamt        ${posts}`);
  if (posts) {
    console.log(`Views pro Post      ${(views / posts).toFixed(1)}`);
    console.log(`Reaktionen pro Post ${(reactions / posts).toFixed(2)}`);
  }
  if (views) {
    console.log(`Reaktionen/1000 Views ${((reactions / views) * 1000).toFixed(1)}`);
  }
  console.log(`Kommentarquote      ${((comments / Math.max(1, views)) * 100).toFixed(2)}%`);

  if (PER_POST) {
    console.log(`\n${"=".repeat(46)}\nJe Post (nur veröffentlichte):\n`);
    const rows = (await perPost()).filter(
      (p) => p.status === "sent" || p.status === "published"
    );
    const num = (p, t) => {
      const v = metricOf(p, t);
      return v === null ? "-" : v;
    };
    rows.sort((a, b) => (num(b, "views") || 0) - (num(a, "views") || 0));
    for (const p of rows.slice(0, 25)) {
      const svc = p.channelService || (p.channel && p.channel.service) || "?";
      const txt = (p.text || "").replace(/\s+/g, " ").slice(0, 34);
      console.log(
        `  ${String(num(p, "views")).padStart(6)} Views  ` +
          `${String(num(p, "reactions")).padStart(3)} R  ` +
          `${String(num(p, "comments")).padStart(3)} K  ` +
          `${String(num(p, "engagementRate")).padStart(6)} %  ` +
          `${svc.padEnd(15)} ${txt}`
      );
    }
    const total = rows.length;
    const got = rows.filter((p) => (metricOf(p, "views") || 0) > 0).length;
    console.log(
      `\n  ${total} veroeffentlichte Posts, davon ${got} mit Views > 0` +
        (total ? ` (${((got / total) * 100).toFixed(0)}%)` : "")
    );
  }
})().catch((e) => {
  console.error("FEHLER:", e.message);
  process.exit(1);
});