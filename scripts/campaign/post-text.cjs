// Gemeinsame Text-Erzeugung fuer alle Buffer-Posts.
//
// Warum: bisher bekamen TikTok, Instagram und YouTube Shorts denselben Satz
// ("Dein Pixel, deine Geschichte ... pixelmaps.org #PixelMaps"), aus nur zwei
// Vorlagen pro Sprache. Das ist auf jedem Kanal falsch:
//   - YouTube Shorts lebt von einem Titel mit Suchbegriff (~60 Zeichen),
//   - TikTok von einem kurzen Hook in der ersten Zeile + wenigen Tags,
//   - Instagram von Hook, Nutzen und "Link in Bio" (Links sind nicht klickbar).
//
// Diese Datei liefert pro Kanal, Sprache und Tag einen eigenen Text und
// Titel. Alles ist deterministisch (Datum + Kanal), damit ein erneuter Lauf
// dieselben Texte erzeugt und keine Duplikate entstehen.
const SITE = "https://pixelmaps.org";

const PLATFORMS = ["TikTok", "Instagram", "YouTubeShorts"];

// Versatz pro Kanal: am selben Tag bekommen die drei Kanaele unterschiedliche
// Hooks statt dreimal denselben Satz.
const OFFSET = { TikTok: 0, Instagram: 1, YouTubeShorts: 2 };

// Wie viele Tags pro Kanal (Discovery kommt fast nur ueber Tags).
const TAG_COUNT = { TikTok: 5, Instagram: 8, YouTubeShorts: 4 };

const COPY = {
  de: {
    hooks: [
      "Such deine Straße. Dann sichere sie dir für 1 €.",
      "1 Milliarde Pixel. Einer gehört dir.",
      "Dein Heimatort als Pixel – für immer auf der Karte.",
      "Ein Euro. Ein Pixel. Ein Stück Welt.",
      "Die Weltkarte ist noch fast leer. Dein Pixel fehlt.",
      "Dein Name, deine Nachricht, dein Pixel auf der Weltkarte.",
    ],
    bodies: [
      "1 € pro Pixel, einmal zahlen. Name, Link und Nachricht stehen direkt auf der Karte, dazu gibt es eine Urkunde als PDF.",
      "Klick dich zu deiner Straße, wähle deinen Pixel und lade dein Zertifikat herunter.",
      "Kein Abo, kein Ablaufdatum: dein Pixel bleibt, wo du ihn gesetzt hast.",
    ],
    cta: { TikTok: "Link in der Bio 👆", Instagram: "🔗 Link in Bio · pixelmaps.org", YouTubeShorts: "Deine Straße suchen:" },
    titles: [
      "Deine Straße auf der Weltkarte – 1 € pro Pixel",
      "Weltkarte aus 1 Milliarde Pixeln: dein Pixel für 1 €",
      "Pixel auf der Weltkarte kaufen – in 30 Sekunden",
      "Ein Pixel, ein Euro, für immer: PixelMaps",
      "Dein Heimatort als Pixel auf der Weltkarte",
    ],
    tags: ["#weltkarte", "#geografie", "#karten", "#pixelart", "#deutschland", "#reisen", "#geschenkidee", "#pixelmaps"],
  },
  en: {
    hooks: [
      "Search your street. Then claim it for €1.",
      "A billion pixels. One of them is yours.",
      "Your hometown as a pixel — on the map forever.",
      "One euro. One pixel. A piece of the world.",
      "The world map is still almost empty. Your pixel is missing.",
      "Your name, your message, your pixel on the world map.",
    ],
    bodies: [
      "€1 per pixel, one payment. Your name, link and message appear right on the map, plus a certificate as PDF.",
      "Zoom to your street, pick your pixel and download your certificate.",
      "No subscription, no expiry: your pixel stays where you put it.",
    ],
    cta: { TikTok: "Link in bio 👆", Instagram: "🔗 Link in bio · pixelmaps.org", YouTubeShorts: "Find your street:" },
    titles: [
      "Your street on the world map – €1 per pixel",
      "A world map of 1 billion pixels: yours for €1",
      "Buy a pixel on the world map in 30 seconds",
      "One pixel, one euro, forever",
      "Your hometown as a pixel on the world map",
    ],
    tags: ["#worldmap", "#geography", "#maps", "#pixelart", "#travel", "#giftideas", "#pixelmaps"],
  },
  es: {
    hooks: [
      "Busca tu calle. Y hazla tuya por 1 €.",
      "Mil millones de píxeles. Uno es tuyo.",
      "Tu ciudad como píxel, para siempre en el mapa.",
      "Un euro. Un píxel. Un trozo del mundo.",
      "El mapa del mundo está casi vacío. Falta tu píxel.",
    ],
    bodies: [
      "1 € por píxel, pago único. Tu nombre, tu enlace y tu mensaje aparecen en el mapa, con certificado en PDF.",
      "Busca tu calle, elige tu píxel y descarga tu certificado.",
      "Sin suscripción y sin caducidad: el píxel es tuyo para siempre.",
    ],
    cta: { TikTok: "Enlace en la bio 👆", Instagram: "🔗 Enlace en la bio · pixelmaps.org", YouTubeShorts: "Busca tu calle:" },
    titles: [
      "Tu calle en el mapa del mundo – 1 € por píxel",
      "Un mapa de mil millones de píxeles: haz tuyo el tuyo",
      "Comprar un píxel en el mapa del mundo en 30 segundos",
      "Un píxel, un euro, para siempre",
    ],
    tags: ["#mapamundi", "#geografía", "#mapas", "#pixelart", "#viajes", "#regalos", "#pixelmaps"],
  },
  fr: {
    hooks: [
      "Cherche ta rue. Puis réserve-la pour 1 €.",
      "Un milliard de pixels. Un seul est à toi.",
      "Ta ville en pixel, pour toujours sur la carte.",
      "Un euro. Un pixel. Un morceau du monde.",
      "Le planisphère est encore presque vide. Il manque ton pixel.",
    ],
    bodies: [
      "1 € par pixel, paiement unique. Ton nom, ton lien et ton message s'affichent sur la carte, avec un certificat en PDF.",
      "Cherche ta rue, choisis ton pixel et télécharge ton certificat.",
      "Pas d'abonnement, pas d'expiration : le pixel reste à toi.",
    ],
    cta: { TikTok: "Lien en bio 👆", Instagram: "🔗 Lien en bio · pixelmaps.org", YouTubeShorts: "Trouve ta rue :" },
    titles: [
      "Ta rue sur le planisphère – 1 € le pixel",
      "Un planisphère d'un milliard de pixels : réserve le tien",
      "Acheter un pixel sur la carte du monde en 30 secondes",
      "Un pixel, un euro, pour toujours",
    ],
    tags: ["#cartedumonde", "#géographie", "#cartes", "#pixelart", "#voyage", "#cadeau", "#pixelmaps"],
  },
  it: {
    hooks: [
      "Cerca la tua via. Poi prenditela per 1 €.",
      "Un miliardo di pixel. Uno è tuo.",
      "La tua città come pixel, per sempre sulla mappa.",
      "Un euro. Un pixel. Un pezzo di mondo.",
      "La mappa del mondo è ancora quasi vuota. Manca il tuo pixel.",
    ],
    bodies: [
      "1 € per pixel, pagamento unico. Nome, link e messaggio appaiono sulla mappa, con certificato in PDF.",
      "Cerca la tua via, scegli il pixel e scarica il certificato.",
      "Nessun abbonamento, nessuna scadenza: il pixel resta tuo.",
    ],
    cta: { TikTok: "Link in bio 👆", Instagram: "🔗 Link in bio · pixelmaps.org", YouTubeShorts: "Cerca la tua via:" },
    titles: [
      "La tua via sulla mappa del mondo – 1 € per pixel",
      "Una mappa da un miliardo di pixel: prendi il tuo",
      "Comprare un pixel sulla mappa del mondo in 30 secondi",
      "Un pixel, un euro, per sempre",
    ],
    tags: ["#mappamondo", "#geografia", "#mappe", "#pixelart", "#viaggi", "#regalo", "#pixelmaps"],
  },
  pt: {
    hooks: [
      "Procura a tua rua. E garante-a por 1 €.",
      "Mil milhões de píxeis. Um é teu.",
      "A tua cidade em píxel, para sempre no mapa.",
      "Um euro. Um píxel. Um pedaço do mundo.",
      "O mapa do mundo ainda está quase vazio. Falta o teu píxel.",
    ],
    bodies: [
      "1 € por píxel, pagamento único. Nome, link e mensagem aparecem no mapa, com certificado em PDF.",
      "Procura a tua rua, escolhe o píxel e descarrega o certificado.",
      "Sem subscrição e sem validade: o píxel fica para sempre.",
    ],
    cta: { TikTok: "Link na bio 👆", Instagram: "🔗 Link na bio · pixelmaps.org", YouTubeShorts: "Procura a tua rua:" },
    titles: [
      "A tua rua no mapa do mundo – 1 € por píxel",
      "Um mapa de mil milhões de píxeis: garante o teu",
      "Comprar um píxel no mapa do mundo em 30 segundos",
      "Um píxel, um euro, para sempre",
    ],
    tags: ["#mapamundo", "#geografia", "#mapas", "#pixelart", "#viagem", "#presente", "#pixelmaps"],
  },
  tr: {
    hooks: [
      "Sokağını bul. 1 € karşılığında sahiplen.",
      "Bir milyar piksel. Biri senin.",
      "Şehrin haritada bir piksel olarak, sonsuza dek.",
      "Bir euro. Bir piksel. Dünyadan bir parça.",
      "Dünya haritası henüz neredeyse boş. Senin pikselin eksik.",
    ],
    bodies: [
      "Piksel başına 1 €, tek ödeme. İsmin, linkin ve mesajın haritada görünür; PDF sertifika da cabası.",
      "Sokağını bul, pikselini seç ve sertifikanı indir.",
      "Abonelik yok, süre yok: piksel senin kalır.",
    ],
    cta: { TikTok: "Bağlantı biyoda 👆", Instagram: "🔗 Bağlantı biyoda · pixelmaps.org", YouTubeShorts: "Sokağını bul:" },
    titles: [
      "Sokağın dünya haritasında – piksel 1 €",
      "Bir milyar piksellik harita: 1 € karşılığında senin olsun",
      "Dünya haritasında piksel satın almak – 30 saniye",
      "Bir piksel, bir euro, sonsuza dek",
    ],
    tags: ["#dünyaharitası", "#coğrafya", "#harita", "#pixelart", "#seyahat", "#hediye", "#pixelmaps"],
  },
  ru: {
    hooks: [
      "Найди свою улицу. И забери её за 1 €.",
      "Миллиард пикселей. Один — твой.",
      "Твой город пикселем — навсегда на карте.",
      "Один евро. Один пиксель. Часть мира.",
      "Карта мира пока почти пустая. Твоего пикселя не хватает.",
    ],
    bodies: [
      "1 € за пиксель, один платёж. Имя, ссылка и сообщение видны на карте, плюс сертификат в PDF.",
      "Найди свою улицу, выбери пиксель и скачай сертификат.",
      "Без подписки и срока действия: пиксель остаётся твоим.",
    ],
    cta: { TikTok: "Ссылка в профиле 👆", Instagram: "🔗 Ссылка в профиле · pixelmaps.org", YouTubeShorts: "Найди свою улицу:" },
    titles: [
      "Твоя улица на карте мира — пиксель за 1 €",
      "Карта из миллиарда пикселей: забери свой за 1 €",
      "Купить пиксель на карте мира за 30 секунд",
      "Один пиксель, один евро, навсегда",
    ],
    tags: ["#картамира", "#география", "#карты", "#пиксельарт", "#путешествия", "#подарок", "#pixelmaps"],
  },
  hi: {
    hooks: [
      "अपनी गली खोजो। और उसे 1 € में अपना बनाओ।",
      "एक अरब पिक्सेल। एक तुम्हारा।",
      "तुम्हारा शहर नक्शे पर हमेशा के लिए एक पिक्सेल के रूप में।",
      "एक यूरो। एक पिक्सेल। दुनिया का एक टुकड़ा।",
      "दुनिया का नक्शा अभी लगभग खाली है। तुम्हारा पिक्सेल बाकी है।",
    ],
    bodies: [
      "प्रति पिक्सेल 1 €, एक ही भुगतान। नाम, लिंक और संदेश नक्शे पर दिखते हैं, साथ में PDF सर्टिफिकेट।",
      "अपनी गली खोजो, पिक्सेल चुनो और सर्टिफिकेट डाउनलोड करो।",
      "कोई सब्सक्रिप्शन नहीं, कोई समय-सीमा नहीं: पिक्सेल तुम्हारा रहेगा।",
    ],
    cta: { TikTok: "लिंक बायो में 👆", Instagram: "🔗 लिंक बायो में · pixelmaps.org", YouTubeShorts: "अपनी गली खोजो:" },
    titles: [
      "दुनिया के नक्शे पर तुम्हारी गली — 1 € में पिक्सेल",
      "एक अरब पिक्सेल का नक्शा: 1 € में अपना लो",
      "30 सेकंड में दुनिया के नक्शे पर पिक्सेल खरीदो",
      "एक पिक्सेल, एक यूरो, हमेशा के लिए",
    ],
    tags: ["#दुनियाकानक्शा", "#भूगोल", "#नक्शा", "#पिक्सेलआर्ट", "#यात्रा", "#उपहार", "#pixelmaps"],
  },
  zh: {
    hooks: [
      "搜索你的街道，用 1 欧元把它留下。",
      "十亿像素，其中一个属于你。",
      "把你所在的城市变成地图上永久的像素。",
      "一欧元，一个像素，世界的一角。",
      "世界地图还几乎是空的，你的像素还空着。",
    ],
    bodies: [
      "每个像素 1 欧元，一次付费。名字、链接和留言会显示在地图上，并附 PDF 证书。",
      "搜索你的街道，选中像素，下载证书。",
      "没有订阅，也不会过期：像素永远属于你。",
    ],
    cta: { TikTok: "链接在主页 👆", Instagram: "🔗 链接在主页 · pixelmaps.org", YouTubeShorts: "搜索你的街道：" },
    titles: [
      "你的街道在世界地图上——每个像素 1 欧元",
      "十亿像素的世界地图：1 欧元留下你的",
      "30 秒在世界地图上买一个像素",
      "一个像素，一欧元，永久保留",
    ],
    tags: ["#世界地图", "#地理", "#地图", "#像素艺术", "#旅行", "#礼物", "#pixelmaps"],
  },
};

const DAY0 = Date.parse("2026-01-01T00:00:00Z") / 86400000;

function dayIndex(dateStr) {
  const d = dateStr || new Date().toISOString().slice(0, 10);
  return Math.floor(Date.parse(d + "T00:00:00Z") / 86400000) - DAY0;
}

// Gemeinsamer Slogan passend zu den Emoji-Pixeln auf der Karte.
// Wird in jedem Kanal als eigene Zeile gesetzt, damit TikTok, Instagram und
// YouTube Shorts dieselbe Kampagne erkennbar tragen.
const SLOGAN = {
  de: "Dein Pixel. Dein Emoji. Für immer.",
  en: "Your pixel. Your emoji. Forever.",
  es: "Tu píxel. Tu emoji. Para siempre.",
  fr: "Ton pixel. Ton emoji. Pour toujours.",
  it: "Il tuo pixel. Il tuo emoji. Per sempre.",
  pt: "O teu píxel. O teu emoji. Para sempre.",
  tr: "Pikselin. Emojin. Sonsuza dek.",
  ru: "Твой пиксель. Твой эмодзи. Навсегда.",
  hi: "तुम्हारा पिक्सेल। तुम्हारा इमोजी। हमेशा के लिए।",
  zh: "你的像素。你的表情。永久保留。",
};

// Emoji-spezifische Hooks. Sie laufen in derselben Rotation wie die
// bestehenden Hooks, damit nicht jeden Tag derselbe Satz erscheint.
const EMOJI_HOOKS = {
  de: [
    "Wähle dein Emoji – es bleibt für immer in deinem Pixel. 🍀",
    "Dein Pixel zeigt jetzt, was du fühlst: dein Emoji.",
    "🌍 🌊 🚀 🦊 – welches Emoji bekommt dein Pixel?",
  ],
  en: [
    "Pick your emoji — it stays in your pixel forever. 🍀",
    "Your pixel now shows how you feel: your emoji.",
    "🌍 🌊 🚀 🦊 — which emoji gets your pixel?",
  ],
  es: [
    "Elige tu emoji: se queda en tu píxel para siempre. 🍀",
    "Tu píxel ahora muestra lo que sientes: tu emoji.",
    "🌍 🌊 🚀 🦊 — ¿qué emoji tendrá tu píxel?",
  ],
  fr: [
    "Choisis ton emoji : il reste dans ton pixel pour toujours. 🍀",
    "Ton pixel montre maintenant ce que tu ressens : ton emoji.",
    "🌍 🌊 🚀 🦊 — quel emoji aura ton pixel ?",
  ],
  it: [
    "Scegli il tuo emoji: resta nel tuo pixel per sempre. 🍀",
    "Il tuo pixel ora mostra ciò che senti: il tuo emoji.",
    "🌍 🌊 🚀 🦊 — quale emoji avrà il tuo pixel?",
  ],
  pt: [
    "Escolhe o teu emoji: fica no teu píxel para sempre. 🍀",
    "O teu píxel agora mostra o que sentes: o teu emoji.",
    "🌍 🌊 🚀 🦊 — qual emoji vai ficar no teu píxel?",
  ],
  tr: [
    "Emojini seç — pikselinde sonsuza dek kalsın. 🍀",
    "Pikselin artık ne hissettiğini gösteriyor: emojin.",
    "🌍 🌊 🚀 🦊 — pikselin hangi emojiyi alacak?",
  ],
  ru: [
    "Выбери эмодзи — он останется в твоём пикселе навсегда. 🍀",
    "Твой пиксель теперь показывает, что ты чувствуешь: твой эмодзи.",
    "🌍 🌊 🚀 🦊 — какой эмодзи получит твой пиксель?",
  ],
  hi: [
    "अपना इमोजी चुनो — वह हमेशा तुम्हारे पिक्सेल में रहेगा। 🍀",
    "तुम्हारा पिक्सेल अब दिखाता है कि तुम क्या महसूस करते हो: तुम्हारा इमोजी।",
    "🌍 🌊 🚀 🦊 — तुम्हारे पिक्सेल को कौन सा इमोजी मिलेगा?",
  ],
  zh: [
    "选一个表情，它会永远留在你的像素里。🍀",
    "你的像素现在展示你的心情：你的表情。",
    "🌍 🌊 🚀 🦊 —— 你的像素会选哪个表情？",
  ],
};

// YouTube-Titel mit Suchbegriff und Emoji-Bezug.
const EMOJI_TITLES = {
  de: ["Dein Pixel, dein Emoji – für immer auf der Weltkarte"],
  en: ["Your pixel, your emoji – forever on the world map"],
  es: ["Tu píxel, tu emoji – para siempre en el mapa"],
  fr: ["Ton pixel, ton emoji – pour toujours sur la carte"],
  it: ["Il tuo pixel, il tuo emoji – per sempre sulla mappa"],
  pt: ["O teu píxel, o teu emoji – para sempre no mapa"],
  tr: ["Pikselin, emojin – dünya haritasında sonsuza dek"],
  ru: ["Твой пиксель, твой эмодзи — навсегда на карте мира"],
  hi: ["तुम्हारा पिक्सेल, तुम्हारा इमोजी — हमेशा के लिए नक्शे पर"],
  zh: ["你的像素，你的表情——永远留在世界地图上"],
};

for (const lang of Object.keys(COPY)) {
  if (SLOGAN[lang]) COPY[lang].slogan = SLOGAN[lang];
  if (EMOJI_HOOKS[lang]) COPY[lang].hooks.unshift(...EMOJI_HOOKS[lang]);
  if (EMOJI_TITLES[lang]) COPY[lang].titles.unshift(...EMOJI_TITLES[lang]);
}

function pick(arr, i) {
  return arr[((i % arr.length) + arr.length) % arr.length];
}

function withUtm(url, platform) {
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", String(platform || "").toLowerCase());
    u.searchParams.set("utm_medium", "social");
    u.searchParams.set("utm_campaign", "daily-post");
    u.searchParams.set("utm_content", String(platform || "").toLowerCase());
    return u.toString();
  } catch (_) {
    return url;
  }
}

function tagsFor(lang, platform, idx) {
  const c = COPY[lang] || COPY.en;
  const n = TAG_COUNT[platform] || 4;
  const pool = c.tags.filter((t) => t !== "#pixelmaps");
  const out = [];
  // n-1 Themen-Tags, dann immer der Marken-Tag – der darf nie wegfallen.
  for (let k = 0; out.length < n - 1 && k < pool.length * 2; k++) {
    const t = pick(pool, idx + k * 3);
    if (!out.includes(t)) out.push(t);
  }
  for (const t of pool) { if (out.length >= n - 1) break; if (!out.includes(t)) out.push(t); }
  return [...out, "#pixelmaps"];
}

// Baut Text + Titel fuer einen Post.
//   platform: "TikTok" | "Instagram" | "YouTubeShorts"
//   lang:     Sprachcode des Clips (de, en, es, fr, it, pt, tr, ru, hi, zh)
//   date:     YYYY-MM-DD (deterministisch pro Tag)
//   design:   "neon" | "pop" (bestehende Rotation, verschiebt die Auswahl)
// salt verschiebt die Auswahl, wenn ein Kanal den Text schon hat.
// clipTitle ist der Titel des Videos selbst; er beschreibt den Inhalt und
// liefert auf YouTube den besseren Titel als eine reine Produktzeile.
function buildPost({ platform, lang, date, design, siteUrl, salt, clipTitle }) {
  const c = COPY[lang] || COPY.en;
  const idx = dayIndex(date) + (OFFSET[platform] || 0) + (design === "pop" ? 1 : 0) + (salt || 0);
  const hook = pick(c.hooks, idx);
  const body = pick(c.bodies, Math.floor(idx / 3));
  const cta = c.cta[platform] || c.cta.Instagram;
  const slogan = c.slogan || "";
  const tags = tagsFor(lang, platform, idx);
  const link = withUtm(siteUrl || SITE, platform);

  let text;
  let title;
  if (platform === "YouTubeShorts") {
    // Titel: Inhalt des Clips zuerst, dann Suchbegriff, dann " #Shorts".
    const base = String(clipTitle || "").trim() || pick(c.titles, idx);
    const hasKeyword = /pixel|píxel|píxeis|piksel|пиксел|पिक्सेल|像素/i.test(base);
    const hasPrice = /€|euro/i.test(base);
    title = hasKeyword || hasPrice ? base : `${base} · 1 €`;
    if (!/#shorts/i.test(title) && title.length + 8 <= 95) title += " #Shorts";
    text = `${hook}\n\n${slogan}\n\n${body}\n\n${cta} ${link}\n\n${tags.join(" ")}`;
  } else if (platform === "Instagram") {
    // Reels: Hook, Slogan, Nutzen, Link-in-Bio. Kein nackter Link im Text.
    title = hook;
    text = `${hook}\n\n${slogan}\n\n${body}\n\n${cta}\n\n${tags.join(" ")}`;
  } else {
    // TikTok: kurz, erste Zeile entscheidet, wenige Tags.
    title = hook;
    text = `${hook}\n${slogan}\n${cta}\n\n${tags.join(" ")}`;
  }
  return { platform, lang, text, title, tags, url: link };
}

// Eine Sprache pro Tag, damit Video und Caption derselben Sprache folgen.
// Der 26.10.2026 ist Anker (de), danach der Reihe nach weiter.
const LANGS = Object.keys(COPY);
const ROTATION_ANCHOR = Date.parse("2026-10-26T00:00:00Z") / 86400000;
function langForDate(date) {
  const d = Math.floor(Date.parse(date + "T00:00:00Z") / 86400000);
  const i = d - ROTATION_ANCHOR;
  return LANGS[((i % LANGS.length) + LANGS.length) % LANGS.length];
}

module.exports = { buildPost, withUtm, dayIndex, langForDate, LANGS, COPY, PLATFORMS, TAG_COUNT };

// Vorschau:  node scripts/campaign/post-text.cjs [tage] [sprache]
if (require.main === module) {
  const days = parseInt(process.argv[2] || "3", 10);
  const lang = process.argv[3] || "de";
  const design = process.argv[4] || "neon";
  const start = Date.now();
  for (let d = 0; d < days; d++) {
    const date = new Date(start + d * 86400000).toISOString().slice(0, 10);
    for (const platform of PLATFORMS) {
      const p = buildPost({ platform, lang, date, design });
      console.log(`\n════ ${date} · ${platform} · ${lang} ════`);
      console.log(`TITEL: ${p.title}`);
      console.log(p.text);
    }
  }
}
