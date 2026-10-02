#!/usr/bin/env node
/* marketing-report.js – taegliche Marketing-Auswertung fuer PixelMaps.
 *
 * Auswertung liefert (je nach Datenquelle verfuegbar):
 *   - Videoaufrufe / Website-Besuche (eigene Zaehlung via pixelmaps.org/api/clipstats)
 *   - YouTube: Views, Likes, Kommentare (je veroeffentlichtem Video des Tages)
 *   - Buffer: welche Posts am Tag ausgeliefert wurden
 *   - Stripe: Checkout-Starts, abgeschlossene Kaeufe, Umsatz
 *
 * Aufruf:
 *   node marketing-report.js              # Vortag
 *   node marketing-report.js --date 2026-09-22
 */
const fs = require("fs");
const path = require("path");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "agent/config.json"), "utf8"));
const MKT = CFG.marketing || {};
const YT_KEY = String(MKT.youtubeApiKey || "");
const YT_CHANNEL = String(MKT.youtubeChannelId || "UC8-E0e5jfzSo6UZ-k3WVB2g");
const STRIPE_KEY = String(MKT.stripeSecretKey || "");
const BUFFER_TOKEN = String(CFG.bufferAccessToken || "");
const ORG = CFG.bufferOrgId || "6aafe8c03cf501260e7e406c";
const REPORT_DIR = path.join(__dirname, "content/reports");

function argVal(name, def = null) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
}
const dateArg = argVal("--date");
const DAY_DATE = dateArg || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

const tag = (v) => "".padEnd(0);
const fmt = (n) => (n === undefined || n === null ? "–" : Number(n).toLocaleString("de-DE"));
const money = (c, minor) => {
  if (c === undefined || minor === undefined) return "–";
  const currency = String(c).toUpperCase();
  const amount = Number(minor) / 100;
  try { return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(amount); }
  catch (_) { return `${amount.toFixed(2)} ${currency}`; }
};

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: j };
}

async function ownStats(day) {
  const { ok, data } = await fetchJson(`https://pixelmaps.org/api/clipstats?day=${day}`);
  if (!ok) return null;
  const byPlat = { TikTok: 0, YouTubeShorts: 0, InstagramReel: 0, Sonstige: 0 };
  for (const c of data.clips || []) {
    const n = c.name || "";
    let k = "Sonstige";
    if (n.includes("TikTok")) k = "TikTok";
    else if (n.includes("YouTubeShorts") || n.includes("YouTube")) k = "YouTubeShorts";
    else if (n.includes("InstagramReel") || n.includes("Instagram")) k = "InstagramReel";
    byPlat[k] += Number(c.count || 0);
  }
  return {
    totalClips: Number(data.totalClips || 0),
    totalPages: Number(data.totalPages || 0),
    perPlatform: byPlat,
    top: (data.clips || []).slice(0, 5)
  };
}

async function eventsDay(day) {
  const { ok, data } = await fetchJson(`https://pixelmaps.org/api/events?day=${day}`);
  if (!ok) return null;
  const by = { a: {}, b: {} };
  for (const e of data.events || []) {
    by[e.grp] = by[e.grp] || {};
    by[e.grp][e.event] = Number(e.count || 0);
  }
  return { a: by.a, b: by.b };
}

function isoDurationToSec(d) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || "");
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

async function youtubeDay(day) {
  if (!YT_KEY) return null;
  const after = day + "T00:00:00Z";
  const before = day + "T23:59:59Z";
  const sUrl = `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${YT_CHANNEL}&type=video&publishedAfter=${encodeURIComponent(after)}&publishedBefore=${encodeURIComponent(before)}&maxResults=50&key=${YT_KEY}`;
  const { ok, data } = await fetchJson(sUrl);
  if (!ok || !data.items) return { error: data.error?.message || `HTTP ${data.error?.code || ""}` };
  const ids = data.items.map((i) => i.id.videoId);
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { data: v } = await fetchJson(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails,snippet&id=${chunk.join(",")}&key=${YT_KEY}`
    );
    for (const it of v.items || []) {
      const stat = it.statistics || {};
      videos.push({
        title: (it.snippet?.title || "").slice(0, 60),
        durationSec: isoDurationToSec(it.contentDetails?.duration),
        views: Number(stat.viewCount || 0),
        likes: Number(stat.likeCount || 0),
        comments: Number(stat.commentCount || 0)
      });
    }
  }
  return {
    count: videos.length,
    videos,
    totalViews: videos.reduce((s, v) => s + v.views, 0),
    totalLikes: videos.reduce((s, v) => s + v.likes, 0),
    totalComments: videos.reduce((s, v) => s + v.comments, 0)
  };
}

async function bufferDay(day) {
  if (!BUFFER_TOKEN) return { count: 0 };
  const H = { Authorization: "Bearer " + BUFFER_TOKEN, "Content-Type": "application/json" };
  const q = `query($o: OrganizationId!){ posts(first:100,input:{organizationId:$o}){ edges{ node{ id channelId status dueAt } } } }`;
  const r = await fetch("https://api.buffer.com", {
    method: "POST", headers: H,
    body: JSON.stringify({ query: q, variables: { o: ORG } })
  });
  const j = await r.json().catch(() => ({}));
  const rows = (j.data?.posts?.edges || []).map((e) => e.node);
  const thatDay = rows.filter((n) => n.dueAt && n.dueAt.slice(0, 10) === day);
  const sent = thatDay.filter((n) => n.status === "posted");
  return {
    count: thatDay.length,
    sent: sent.length,
    byStatus: thatDay.reduce((acc, n) => { acc[n.status] = (acc[n.status] || 0) + 1; return acc; }, {})
  };
}

async function stripeDay(day) {
  if (!STRIPE_KEY) return null;
  const gte = Math.floor(Date.parse(day + "T00:00:00Z") / 1000);
  const lte = Math.floor(Date.parse(day + "T23:59:59Z") / 1000);
  const H = { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" };
  let started = 0, paid = 0, revenueMinor = 0, ccy = "eur";
  let hasMore = true, starting_after;
  while (hasMore) {
    const params = new URLSearchParams({
      "created[gte]": gte,
      "created[lte]": lte,
      limit: "100"
    });
    if (starting_after) params.set("starting_after", starting_after);
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions?" + params.toString(), { headers: H });
    const j = await r.json().catch(() => ({}));
    const list = j.data || [];
    for (const s of list) {
      started++;
      if (s.status === "complete" && s.payment_status === "paid") {
        paid++;
        revenueMinor += Number(s.amount_total || 0);
        ccy = s.currency || ccy;
      }
    }
    hasMore = !!j.has_more;
    starting_after = list.length ? list[list.length - 1].id : undefined;
  }
  return { started, paid, revenueMinor, ccy, live: STRIPE_KEY.startsWith("sk_live_") };
}

function renderText(day, own, yt, buf, str, ev) {
  const lines = [];
  lines.push(`# PixelMaps Marketing-Report – ${day}`);
  lines.push(`Erstellt: ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC · Zeitzone der Kennzahlen: UTC`);
  lines.push("");
  lines.push("## Kennzahlen");
  lines.push("");
  lines.push("| Kennzahl | Wert | Quelle |");
  lines.push("|---|---|---|");
  lines.push(`| Videoaufrufe (eigene Auslieferung) | ${fmt(own && own.totalClips)} | pixelmaps.org/clips (D1-Zaehlung) |`);
  lines.push(`| YouTube Views (neue Videos) | ${yt ? fmt(yt.totalViews) : "–"} | YouTube Data API${yt ? "" : " (API-Key fehlt)"} |`);
  lines.push(`| YouTube Kommentare | ${yt ? fmt(yt.totalComments) : "–"} | YouTube Data API |`);
  lines.push(`| Geteilte Beiträge | – | nur Plattform-Dashboard |`);
  lines.push(`| Profilbesuche | – | nur TikTok/IG-Analytics (Business-Konto) |`);
  lines.push(`| Website-Besuche (Seitenabrufe) | ${fmt(own && own.totalPages)} | pixelmaps.org (D1-Zaehlung) |`);
  lines.push(`| Checkout-Starts | ${str ? fmt(str.started) : "–"} | Stripe${str ? "" : (STRIPE_KEY ? "" : " (Live-Key fehlt)")} |`);
  lines.push(`| Abgeschlossene Käufe | ${str ? fmt(str.paid) : "–"} | Stripe |`);
  lines.push(`| Umsatz | ${str ? money(str.ccy, str.revenueMinor) : "–"} | Stripe |`);
  lines.push("");
  lines.push("## Details");
  lines.push("");
  if (own) {
    lines.push(`**Clips der eigenen Auslieferung:** TikTok ${fmt(own.perPlatform.TikTok)} · YouTubeShorts ${fmt(own.perPlatform.YouTubeShorts)} · InstagramReel ${fmt(own.perPlatform.InstagramReel)} · Sonstige ${fmt(own.perPlatform.Sonstige)}`);
    if (own.top.length) {
      lines.push("");
      lines.push("**Top-Clips:**");
      for (const t of own.top) lines.push(`- \`${t.name}\` – ${t.count}`);
    }
  }
  if (yt && yt.error) {
    lines.push("");
    lines.push("**YouTube:** API-Fehler: " + yt.error);
  } else if (yt) {
    lines.push("");
    lines.push(`**YouTube:** ${yt.count} Video(s) am Tag publiziert, ${fmt(yt.totalViews)} Views, ${fmt(yt.totalLikes)} Likes, ${fmt(yt.totalComments)} Kommentare.`);
    for (const v of yt.videos) {
      lines.push(`- "${v.title}" – ${v.durationSec}s – ${fmt(v.views)} Views / ${fmt(v.likes)} Likes / ${fmt(v.comments)} Kommentare`);
    }
  }
  if (buf) {
    lines.push("");
    lines.push(`**Buffer:** ${buf.count} Posts an diesem Tag auf Plan, ${buf.sent} als ausgeliefert markiert. Status: ${JSON.stringify(buf.byStatus)}`);
  }
  if (str) {
    lines.push("");
    lines.push(`**Stripe (${str.live ? "live" : "TEST"}):** ${fmt(str.started)} Checkout-Starts, ${fmt(str.paid)} Käufe, Umsatz ${money(str.ccy, str.revenueMinor)}.`);
  }
  if (ev) {
    lines.push("");
    lines.push("**Website-Funnel (A/B-Gruppen):**");
    const row = (g) => {
      const e = ev[g] || {};
      const cta = Number(e.cta_click || 0), open = Number(e.checkout_open || 0), sub = Number(e.checkout_submit || 0);
      return `- Gruppe **${g}**: CTA ${fmt(cta)} · Checkout geöffnet ${fmt(open)} · Stripe-Start ${fmt(sub)}` +
        (cta ? ` (Conversion CTA→Checkout ${(open / cta * 100).toFixed(1)} %, Checkout→Start ${(sub / open * 100).toFixed(1)} %)` : "");
    };
    lines.push(row("a"));
    lines.push(row("b"));
  }
  lines.push("");
  lines.push("## Nicht automatisch erfasst (offen)");
  lines.push("");
  lines.push("- **Wiedergabezeit / Retention:** nur über YouTube Analytics API (OAuth) und TikTok/IG-Insights (Business/Kreator-Konto).");
  lines.push("- **Geteilte Beiträge & Profilbesuche:** nur über die Plattform-Dashboards; für TikTok/IG erst mit Business/Upgrade-Account.");
  lines.push("- **Reichweite/Engagement TikTok & Instagram:** aktuell keine API-Zugriffe (Kanäle/persönliches Profil).");
  lines.push("");
  return lines.join("\n");
}

(async () => {
  const [own, yt, buf, str, ev] = await Promise.all([
    ownStats(DAY_DATE),
    youtubeDay(DAY_DATE),
    bufferDay(DAY_DATE),
    stripeDay(DAY_DATE),
    eventsDay(DAY_DATE)
  ]);
  const title = `PixelMaps Marketing-Report ${DAY_DATE}`;
  const md = renderText(DAY_DATE, own, yt, buf, str, ev);
  const [y, m] = DAY_DATE.split("-");
  const dir = path.join(REPORT_DIR, y, m);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${DAY_DATE}.md`);
  fs.writeFileSync(file, md);
  console.log("Report geschrieben:", file);
  console.log("---");
  console.log(md.split("\n").slice(0, 14).join("\n"));
})().catch((e) => {
  console.error("FEHLER:", e.message);
  process.exit(1);
});