#!/usr/bin/env node
// Idempotenter Buffer-Queue-Füller: hält pro Kanal max. 10 scheduled Posts
// und plant fehlende Tage (morgen .. +13) mit Design-/Sprachrotation nach.
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(__dirname + "/agent/config.json", "utf8"));
const H = { Authorization: "Bearer " + cfg.bufferAccessToken, "Content-Type": "application/json" };
const ORG = cfg.bufferOrgId || "6aafe8c03cf501260e7e406c";
const CH = cfg.bufferChannels || {};
const MAX = 10, WANT = 14;

const LANGS = ["de", "en", "es", "fr", "it", "pt", "tr"];
const DAY0 = Date.parse("2026-09-22T00:00:00Z") / 86400000;
function dayInfo(dStr) {
  const idx = Math.floor(Date.parse(dStr + "T00:00:00Z") / 86400000) - DAY0;
  return { design: (idx % 2) === 0 ? "neon" : "pop", lang: LANGS[((idx % 7) + 7) % 7] };
}
function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

const TEXT = {
  pop: {
    de: "1 Milliarde Pixel, ein Planet, dein Stück für immer. 🌍 Die farbigste Weltkarte der Welt – pixelmaps.org #PixelMaps",
    en: "A billion pixels, one planet, your piece forever. 🌍 The most colourful world map – pixelmaps.org #PixelMaps",
    es: "Mil millones de píxeles, un planeta, tu pedacito para siempre. 🌍 El mapa más colorido del mundo – pixelmaps.org #PixelMaps",
    fr: "Un milliard de pixels, une planète, ton coin pour toujours. 🌍 Le planisphère le plus coloré du monde – pixelmaps.org #PixelMaps",
    it: "Un miliardo di pixel, un pianeta, il tuo pezzetto per sempre. 🌍 La mappa più colorata del mondo – pixelmaps.org #PixelMaps",
    pt: "Mil milhões de pixels, um planeta, o teu pedacinho para sempre. 🌍 O mapa mais colorido do mundo – pixelmaps.org #PixelMaps",
    tr: "Bir milyar piksel, bir gezegen, senin parçan sonsuza dek. 🌍 Dünyanın en renkli haritası – pixelmaps.org #PixelMaps",
  },
  neon: {
    de: "Dein Pixel, deine Geschichte auf der Weltkarte. 🌍 1 Milliarde Punkte – einer gehört dir. pixelmaps.org #PixelMaps",
    en: "Your pixel, your story on the world map. 🌍 1 billion dots – one is yours. pixelmaps.org #PixelMaps",
    es: "Tu píxel, tu historia en el mapa del mundo. 🌍 1000 millones de puntos – uno es tuyo. pixelmaps.org #PixelMaps",
    fr: "Ton pixel, ton histoire sur le planisphère. 🌍 Un milliard de points – un est à toi. pixelmaps.org #PixelMaps",
    it: "Il tuo pixel, la tua storia sulla mappa del mondo. 🌍 Un miliardo di punti – uno è tuo. pixelmaps.org #PixelMaps",
    pt: "Teu píxel, a tua história no mapa do mundo. 🌍 Mil milhões de pontos – um é teu. pixelmaps.org #PixelMaps",
    tr: "Senin pikselin, senin hikâyen dünya haritasında. 🌍 Bir milyar nokta – biri senin. pixelmaps.org #PixelMaps",
  },
};
const TTL = {
  pop: {
    de: "Die farbigste Weltkarte der Welt", en: "The most colourful world map", es: "El mapa del mundo más colorido",
    fr: "Le planisphère le plus coloré", it: "La mappa più colorata del mondo", pt: "O mapa do mundo mais colorido",
    tr: "Dünyanın en renkli haritası",
  },
  neon: {
    de: "Dein Pixel. Deine Geschichte.", en: "Your pixel. Your story.", es: "Tu píxel. Tu historia.",
    fr: "Ton pixel. Ton histoire.", it: "Il tuo pixel. La tua storia.", pt: "Teu píxel. A tua história.",
    tr: "Senin pikselin. Senin hikâyen.",
  },
};

async function gql(q, v) {
  const r = await fetch("https://api.buffer.com", { method: "POST", headers: H, body: JSON.stringify({ query: q, variables: v }) });
  return r.json();
}

function modeFor(platform, dueAt) {
  const input = {
    text: "", channelId: CH[platform], assets: [], metadata: {},
    schedulingType: platform === "Instagram" ? "notification" : "automatic",
    mode: "customScheduled", dueAt, needsApproval: false,
  };
  return input;
}

(async () => {
  const j = await gql(`query($o: OrganizationId!){ posts(first:100,input:{organizationId:$o}){ edges{ node{ id channelId status dueAt } } } }`, { o: ORG });
  const rows = j.data.posts.edges.map((e) => e.node);
  const now = Date.now();
  const want = {};
  for (let i = 1; i <= WANT; i++) {
    const d = isoDate(now + i * 86400000);
    want[d] = dayInfo(d);
  }
  let created = 0;
  for (const [platform, cid] of Object.entries(CH)) {
    if (!cid) continue;
    let scheduled = rows.filter((n) => n.channelId === cid && n.status === "scheduled" && Date.parse(n.dueAt) > now).length;
    const have = new Set(rows.filter((n) => n.channelId === cid && n.dueAt && n.status !== "posted").map((n) => n.dueAt.slice(0, 10)));
    for (const [day, info] of Object.entries(want)) {
      if (scheduled >= MAX) break;
      if (have.has(day)) continue;
      const text = TEXT[info.design][info.lang], title = TTL[info.design][info.lang];
      const base = "https://pixelmaps.org/clips/generated";
      const asset = platform === "TikTok"
        ? { video: { url: `${base}/${day}-TikTok.mp4`, metadata: { title } } }
        : platform === "YouTubeShorts"
          ? { video: { url: `${base}/${day}-YouTubeShorts.mp4`, metadata: { title } }, metadata: { youtube: { title, categoryId: "22", privacy: "public" } } }
          : { video: { url: `${base}/${day}-InstagramReel.mp4`, metadata: { title } }, metadata: { instagram: { type: "reel", shouldShareToFeed: true } } };
      const input = { text, channelId: cid, assets: [asset.video], metadata: asset.metadata, schedulingType: platform === "Instagram" ? "notification" : "automatic", mode: "customScheduled", dueAt: `${day}T16:00:00Z`, needsApproval: false };
      try {
        const r = await gql(`mutation($i:CreatePostInput!){ createPost(input:$i){ ... on PostActionSuccess{ post{ id } } ... on MutationError{ message } } }`, { i: input });
        const d = r.data && r.data.createPost;
        if (d && d.post) { created++; scheduled++; console.log(`OK  ${day} ${platform.padEnd(12)} ${info.design}|${info.lang} ${d.post.id}`); }
        else console.log(`FEHLER ${day} ${platform}: ${(d && d.message) || JSON.stringify(r).slice(0, 120)}`);
      } catch (e) { console.log(`CRASH ${day} ${platform}: ${e.message}`); }
    }
  }
  console.log(`Fertig – neu geplant: ${created}`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });