import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const json = (data, status=200, headers={}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {"content-type":"application/json; charset=utf-8", ...headers}
  });

const cors = {
  "access-control-allow-origin":"*",
  "access-control-allow-methods":"GET,POST,OPTIONS",
  "access-control-allow-headers":"content-type"
};

function withCors(res) {
  const h = new Headers(res.headers);
  for (const [k,v] of Object.entries(cors)) h.set(k,v);
  return new Response(res.body, {status:res.status, headers:h});
}

// Verifiziert, dass ein Adress-Label zur realen Lage der Koordinate passt.
// Falls ja: {ok:true, place}. Falls das Label klar widerspricht oder die
// echte Lage nicht ermittelbar ist: {ok:false, place: bestEffortPlace}.
async function verifyLabel(env, lat, lon, label) {
  const livePlace = (await getPlaceName(lat, lon, env)).trim();
  if (!label || !livePlace) return { ok: !!label && !livePlace, place: livePlace || "" };
  const keyTokens = livePlace.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 3);
  const kept = keyTokens.some((t) => label.toLowerCase().includes(t));
  return { ok: kept, place: kept ? label : livePlace };
}

function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

async function trackView(env, kind, name) {
  try {
    await env.DB.prepare(`
      INSERT INTO views(day, kind, name, count) VALUES (?, ?, ?, 1)
      ON CONFLICT(day, kind, name) DO UPDATE SET count = count + 1
    `).bind(utcDay(), kind, name).run();
  } catch (e) {
    console.log("trackView:", e.message);
  }
}

// Boot-Migration fuer Agenten-Schema (Moderation). Idempotent: laeuft einmal
// pro Isolate beim ersten Request. D1-CLI hat keinen Schreibzugriff (Token),
// daher erledigt der Worker das selbst.
let _schemaReady = false;
async function safeAlter(env, table, definition) {
  try { await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${definition}`).run(); }
  catch (e) { if (!/duplicate column/i.test(String(e.message))) console.log("alter:", e.message); }
}
async function ensureSchema(env) {
  if (_schemaReady) return;
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS moderation_log (
      id TEXT PRIMARY KEY,
      pixel_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      flags TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_moderation_log_pixel ON moderation_log(pixel_id)").run();
    await safeAlter(env, "pixels", "moderation_status TEXT NOT NULL DEFAULT 'pending'");
    await safeAlter(env, "pixels", "moderation_updated_at TEXT");
    await safeAlter(env, "purchases", "followup_sent_at TEXT");
    _schemaReady = true;
  } catch (e) {
    console.log("ensureSchema:", e.message);
  }
}

function adminOk(request, env) {
  const k = String(request.headers.get("x-admin-key") || "");
  const want = String(env.MODERATION_KEY || "");
  if (!k || !want || k.length !== want.length) return false;
  return timingSafeEqual(k, want);
}

function hash32(s) {
  let h = 2166136261;
  for (let i=0;i<s.length;i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Equirectangular global grid.
// 1,000,000,000 cells = 40,000 columns x 25,000 rows.
const COLS = 40000;
const ROWS = 25000;
const TOTAL = COLS * ROWS;

function idToGeo(id) {
  const row = Math.floor(id / COLS);
  const col = id % COLS;
  const lon = -180 + (col + 0.5) * 360 / COLS;
  const lat = 90 - (row + 0.5) * 180 / ROWS;
  return {lat, lon};
}

function geoToId(lat, lon) {
  const clat = Math.max(-90, Math.min(90, Number(lat)));
  let x = ((Number(lon) + 180) / 360);
  x = ((x % 1) + 1) % 1;
  const col = Math.min(COLS-1, Math.floor(x * COLS));
  const row = Math.min(ROWS-1, Math.max(0, Math.floor((90-clat)/180 * ROWS)));
  return row * COLS + col;
}

// Landeswaehrung: 1 EUR Pauschalpreis, angezeigt und belastet in der
// jeweiligen Landeswaehrung (Basis ~1 EUR, Kurse sind Platzhalter und
// koennen ueber die envoronment-variable FX_RATES.json taeglich
// aktualisiert werden, z.B. {"usd":1.09,"gbp":0.85}).
const DEFAULT_FX_EUR = {
  eur:1, usd:1.08, gbp:0.85, chf:0.94, cad:1.47, aud:1.63, nzd:1.78,
  sgd:1.43, hkd:8.40, sek:11.30, nok:11.80, dkk:7.45, pln:4.30,
  czk:25.20, huf:395.0, ron:5.00, brl:5.90, mxn:20.0, ars:1180,
  cop:4600, clp:980, pen:4.10, inr:91.0, idr:17400, thb:37.0,
  vnd:27000, php:63.0, myr:4.60, twd:34.60, krw:1480, jpy:169,
  cny:7.70, ils:4.00, try:38.0, zar:19.5, rub:104, uah:45.5,
  egp:32.0, ngn:1750, bgn:1.96, isk:148
};

// Laendermapping auf eine von Stripe unterstuetzte Waehrung.
const COUNTRY_CCY = {
  DE:"eur", AT:"eur", CH:"chf", LI:"chf", LU:"eur", BE:"eur", NL:"eur",
  FR:"eur", ES:"eur", IT:"eur", PT:"eur", IE:"eur", FI:"eur", GR:"eur",
  SK:"eur", SI:"eur", EE:"eur", LV:"eur", LT:"eur", CY:"eur", MT:"eur",
  HR:"eur", US:"usd", GB:"gbp", CA:"cad", AU:"aud", NZ:"nzd", SG:"sgd",
  HK:"hkd", SE:"sek", NO:"nok", DK:"dkk", PL:"pln", CZ:"czk", HU:"huf",
  RO:"ron", BG:"bgn", IS:"isk", BR:"brl", MX:"mxn", AR:"ars", CO:"cop",
  CL:"clp", PE:"pen", IN:"inr", ID:"idr", TH:"thb", VN:"vnd", PH:"php",
  MY:"myr", TW:"twd", KR:"krw", JP:"jpy", CN:"cny", IL:"ils", TR:"try",
  ZA:"zar", RU:"rub", UA:"uah", EG:"egp", NG:"ngn"
};

// Kaufkraft-Nachlass (PPP): Basispreis in EUR-Cent je Land, damit der Kauf in
// Emerging Markets erschwinglich bleibt (>Conversion). Tiere halten den
// Preis in stabilen Waehrungen bei vollem 1 EUR-Basispreis.
const BASE_EUR_CENTS_DEFAULT = 100;
const PPP_EUR_CENTS = {
  DE:100, AT:100, CH:100, LI:100, LU:100, BE:100, NL:100,
  FR:100, ES:100, IT:100, PT:100, IE:100, FI:100, GR:100,
  SK:100, SI:100, EE:100, LV:100, LT:100, CY:100, MT:100,
  HR:100, US:100, GB:100, CA:100, AU:100, NZ:100, SG:100,
  HK:100, SE:100, NO:100, DK:100, IL:100, JP:100, KR:100,
  TW:100,
  // Oestliches Europa / Naher Osten: leicht reduziert
  PL:85, CZ:85, HU:85, RO:85, BG:85, IS:100, TR:60,
  // Emerging: deutlich guenstiger
  MX:60, BR:60, CL:75, CO:60, PE:60, AR:50,
  IN:60, PK:60, BD:60, LK:60, NP:60,
  ID:60, TH:60, VN:50, PH:50, MY:60,
  CN:60, ZA:60, EG:50, NG:40, UA:60, RU:60
};

function fxRates(env) {
  try {
    const patch = JSON.parse(env.FX_RATES || "{}");
    return {...DEFAULT_FX_EUR, ...patch};
  } catch (_) {
    return DEFAULT_FX_EUR;
  }
}

// Liefert {currency, unit_amount, decimals, display, fx} fuer 1 EUR
// in der Waehrung des Landes-Codes (mit PPP-Nachlass je Land).
function getPrice(cc, env) {
  let currency = "";
  if (typeof cc === "string" && cc) {
    currency = COUNTRY_CCY[cc.toUpperCase()] || "";
  }
  if (!currency) currency = "eur";

  const rate = fxRates(env)[currency] || 1;
  const baseCents = PPP_EUR_CENTS[String(cc || "").toUpperCase()] ?? BASE_EUR_CENTS_DEFAULT;
  let decimals = 2;
  try {
    decimals = new Intl.NumberFormat("de", {
      style:"currency", currency
    }).resolvedOptions().maximumFractionDigits;
  } catch (_) {
    decimals = 2;
  }
  // unit_amount = Basispreis (EUR-Cent, PPP) * Rate, in Minor-Einheiten der Zielwaehrung.
  // z.B. DE: 100ct * 1.00 = 1.00 EUR; IN: 60ct * 91.0 = 54.60 INR.
  const unit_amount = Math.max(1, Math.round((baseCents / 100) * rate * Math.pow(10, decimals)));
  let display = unit_amount.toFixed(decimals) + " " + currency.toUpperCase();
  try {
    display = new Intl.NumberFormat("de", {
      style:"currency", currency
    }).format(unit_amount / Math.pow(10, decimals));
  } catch (_) {}

  return {currency, unit_amount, decimals, display, base_cents: baseCents, fx: rate};
}

function clientCountry(request) {
  return String(request.headers.get("cf-ipcountry") || "").toUpperCase();
}

function clientIp(request) {
  return String(request.headers.get("cf-connecting-ip") || "").slice(0, 64);
}

async function stripeFetch(env, path, options={}) {
  return fetch("https://api.stripe.com/v1/" + path, {
    ...options,
    headers: {
      "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(options.headers || {})
    }
  });
}

function formEncode(obj) {
  return Object.entries(obj).map(([k,v]) =>
    encodeURIComponent(k)+"="+encodeURIComponent(v ?? "")
  ).join("&");
}

// Temporary worldwide place lookup.
// This intentionally returns a place/town rather than a street address.
// For the final 1-billion-pixel world dataset we should replace this with
// precomputed administrative/place polygons instead of doing live lookups.
async function getPlaceName(lat, lon, env) {
  const roundedLat = Number(lat).toFixed(5);
  const roundedLon = Number(lon).toFixed(5);
  const cacheKey = new Request(`https://pixelmaps-place-cache.invalid/${roundedLat}/${roundedLon}`);
  const cache = caches.default;

  try {
    const cached = await cache.match(cacheKey);
    if (cached) return await cached.text();
  } catch (_) {}

  const ua = env.NOMINATIM_USER_AGENT || "PixelMaps/1.0 (pixelmaps.org)";
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=10&addressdetails=1&accept-language=de,en`;

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": ua,
        "Accept": "application/json"
      }
    });
    if (!r.ok) return "";
    const data = await r.json();
    const a = data?.address || {};
    const place =
      a.city || a.town || a.village || a.municipality ||
      a.county || a.state_district || a.state || "";
    const result = String(place || "").trim().slice(0,120);
    if (result) {
      try {
        await cache.put(cacheKey, new Response(result, {
          headers: {"cache-control":"public, max-age=31536000"}
        }));
      } catch (_) {}
    }
    return result;
  } catch (e) {
    console.log("Place lookup:", e.message);
    return "";
  }
}

function sanitizeWebsite(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) return "";
  return v.replace(/[\u0000-\u001f\u007f<>"']/g, "").slice(0, 500);
}

// Erlaubte Emojis fuer die Pixel-Markierung (Whitelist, keine Downloads/externe Ressourcen).
const ALLOWED_EMOJI = new Set([
  "🐠","🐙","🦈","🐬","🐋","🦀","🐊","🐼","🦊","🐸",
  "🐝","🦋","🌵","🌴","🍀","🌸","🌊","⛰️","🏝️","🏔️",
  "🎄","⛵","🚀","⭐","🔥","💎","🎯","⚽","🎲","🎧",
  "🎵","❤️","🤙","😎"
]);

async function createCheckout(env, body, request) {
  const pixelId = Number(body.pixel_id);
  if (!Number.isInteger(pixelId) || pixelId < 0 || pixelId >= TOTAL)
    throw new Error("Invalid pixel");

  if (request) {
    const origin = request.headers.get("origin");
    if (origin) {
      let ownHost = "";
      let siteHost = "";
      try { ownHost = new URL(request.url).host; } catch (_) {}
      try { siteHost = new URL(env.SITE_URL).host; } catch (_) {}

      let originHost = "";
      try { originHost = new URL(origin).host; } catch (_) {}

      const allowed = originHost &&
        (originHost === ownHost || (!!siteHost && originHost === siteHost));

      if (!allowed) throw new Error("Invalid request origin");
    }
  }

  const existing = await env.DB.prepare("SELECT pixel_id FROM pixels WHERE pixel_id=?")
    .bind(pixelId).first();
  if (existing) throw new Error("Pixel already sold");

  // Alte, nie bezahlte Reservierungen ablaufen lassen.
  await env.DB.prepare(`
    DELETE FROM purchases
    WHERE pixel_id=? AND status='pending'
      AND created_at < datetime('now','-30 minutes')
  `).bind(pixelId).run();

  const pending = await env.DB.prepare(`
    SELECT pixel_id FROM purchases WHERE pixel_id=? AND status='pending'
  `).bind(pixelId).first();
  if (pending) throw new Error("This pixel is being secured by someone else right now. Please try again in a few minutes.");

  const ip = clientIp(request);
  if (ip) {
    const recent = await env.DB.prepare(`
      SELECT COUNT(*) AS n FROM purchases
      WHERE ip=? AND created_at > datetime('now','-1 minute')
    `).bind(ip).first();
    if (Number(recent?.n || 0) >= 5)
      throw new Error("Too many checkout attempts. Please wait a moment.");
  }

  const price = getPrice(String(body.cc || clientCountry(request) || ""), env);
  const purchaseId = crypto.randomUUID();
  const geo = idToGeo(pixelId);
  // Optionaler Adress-Label aus der Suche (/api/search, Nominatim) – nur
  // uebernehmen, wenn er zur echten Lage der Pixelzelle passt.
  const bodyLabel = String(body.place_label || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 150);
  const placeName = bodyLabel
    ? (await verifyLabel(env, geo.lat, geo.lon, bodyLabel)).place
    : await getPlaceName(geo.lat, geo.lon, env);
  const name = String(body.display_name || "").trim().slice(0,120);
  const email = String(body.email || "").trim().slice(0,200);
  const website = sanitizeWebsite(body.website);
  const message = String(body.message || "").trim().slice(0,500);
  const emoji = String(body.emoji || "").trim();
  if (emoji && !ALLOWED_EMOJI.has(emoji)) throw new Error("Invalid emoji");
  const consent = body.consent === true || body.consent === "true" || String(body.consent) === "1";

  if (!name || !email) throw new Error("Name and email are required");
  if (!consent) throw new Error("Consent to the privacy policy is required");

  try {
    await env.DB.prepare(`
      INSERT INTO purchases
      (id,email,display_name,website,status,currency,amount_minor,pixel_id,ip,consent_given,consent_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    `).bind(
      purchaseId,email,name,website,"pending",
      price.currency,price.unit_amount,pixelId,ip,1
    ).run();
  } catch (e) {
    if (String(e?.message || "").toLowerCase().includes("unique") ||
        String(e?.message || "").toLowerCase().includes("constraint"))
      throw new Error("This pixel is being secured by someone else right now. Please try again in a few minutes.");
    throw e;
  }

  const success = `${env.SITE_URL}/?success=1&session_id={CHECKOUT_SESSION_ID}&pixel=${pixelId}&tok=${purchaseId}`;
  const cancel = `${env.SITE_URL}/?cancelled=1&pixel=${pixelId}`;
  const locationText = placeName || `Grid ${geo.lat.toFixed(5)}°, ${geo.lon.toFixed(5)}°`;

  const params = formEncode({
    mode:"payment",
    "line_items[0][price_data][currency]":price.currency,
    "line_items[0][price_data][product_data][name]":"PixelMaps — 1 geographic pixel",
    "line_items[0][price_data][product_data][description]":`Pixel ${pixelId} — ${locationText}`,
    "line_items[0][price_data][unit_amount]":String(price.unit_amount),
    "line_items[0][quantity]":"1",
    success_url:success,
    cancel_url:cancel,
    customer_email:email,
    "metadata[purchase_id]":purchaseId,
    "metadata[pixel_id]":String(pixelId),
    "metadata[display_name]":name,
    "metadata[website]":website,
    "metadata[message]":message,
    "metadata[emoji]":emoji,
    "metadata[place_name]":placeName
  });

  const r = await stripeFetch(env,"checkout/sessions",{method:"POST",body:params});
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || "Stripe error");

  await env.DB.prepare("UPDATE purchases SET stripe_session_id=? WHERE id=?")
    .bind(data.id,purchaseId).run();

  return {url:data.url, pixel_id:pixelId, place_name:placeName, currency:price.currency, unit_amount:price.unit_amount, token:purchaseId};
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function sendCertificateEmail(env, {to, displayName, pixelId, placeName, certificateNo, pdf}) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");
  const from = env.RESEND_FROM_EMAIL || "PixelMaps <zertifikat@pixelmaps.org>";
  const location = placeName || "your geographic pixel";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `pixelmaps-certificate-${certificateNo}`
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `PixelMaps World Record Certificate · Pixel ${pixelId}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#17202a">
          <h1 style="margin-bottom:8px">PIXELMAPS</h1>
          <h2>Your geographic pixel is registered</h2>
          <p>Hello ${escapeHtml(displayName || "")},</p>
          <p>Thank you for your purchase. Your PixelMaps geographic pixel has been successfully registered.</p>
          <p><strong>Pixel:</strong> ${pixelId}<br>
          <strong>Location:</strong> ${escapeHtml(location)}<br>
          <strong>Certificate:</strong> ${escapeHtml(certificateNo)}</p>
          <p>Your PixelMaps World Record Certificate is attached as a PDF.</p>
          <p>Best regards,<br>PixelMaps</p>
        </div>`,
      attachments: [{
        filename: `pixelmaps-zertifikat-${pixelId}.pdf`,
        content: bytesToBase64(pdf),
        content_type: "application/pdf"
      }]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`Resend ${response.status}: ${data?.message || data?.error || JSON.stringify(data).slice(0, 500)}`);
  console.log("Certificate email sent:", data?.id || "ok");
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"\']/g, (m) => {
    if (m === "&") return "&amp;";
    if (m === "<") return "&lt;";
    if (m === ">") return "&gt;";
    if (m === '\"') return "&quot;";
    return "&#39;";
  });
}

// Schliesst eine bezahlte Checkout-Session ab: Kauf als paid markieren, Pixel
// anlegen, Zertifikat erzeugen, PDF erzeugen + mailen. Idempotent (Webhook UND
// Verify-bei-Rueckkehr nutzen dieselbe Funktion).
async function completePaidSession(env, s) {
  const purchaseId = s.metadata?.purchase_id;
  const pixelId = Number(s.metadata?.pixel_id);

  if (!purchaseId || !Number.isInteger(pixelId) || pixelId < 0 || pixelId >= TOTAL) {
    return { purchased: false, reason: "bad metadata", pixel_id: pixelId };
  }

  const p = await env.DB.prepare("SELECT * FROM purchases WHERE id=?").bind(purchaseId).first();
  if (!p) return { purchased: false, reason: "no purchase row", pixel_id: pixelId };

  const gotAmount = Number(s.amount_total);
  const gotCurrency = String(s.currency || "").toLowerCase();
  const expectedAmount = Number(p.amount_minor || 0);
  const expectedCurrency = String(p.currency || "").toLowerCase();
  if (expectedAmount > 0 && (gotAmount !== expectedAmount || gotCurrency !== expectedCurrency)) {
    return { purchased: false, reason: "amount/currency mismatch", pixel_id: pixelId };
  }

  const wasPaid = p.status === "paid";
  if (!wasPaid) {
    await env.DB.prepare("UPDATE purchases SET status='paid',paid_at=CURRENT_TIMESTAMP WHERE id=?").bind(purchaseId).run();
  }

  const geo = idToGeo(pixelId);
  try {
    const existingPixel = await env.DB.prepare("SELECT purchase_id FROM pixels WHERE pixel_id=?").bind(pixelId).first();
    if (!existingPixel) {
      try {
        await env.DB.prepare(`
          INSERT INTO pixels(pixel_id,lat,lon,purchase_id,display_name,website,message,emoji)
          VALUES (?,?,?,?,?,?,?,?)
        `).bind(
          pixelId,geo.lat,geo.lon,purchaseId,
          p.display_name,p.website,s.metadata?.message || "",s.metadata?.emoji || ""
        ).run();
      } catch (e) {
        await refundLosingPurchase(env, s);
        return { purchased: false, reason: "pixel conflict, refunded", pixel_id: pixelId };
      }
    } else if (existingPixel.purchase_id !== purchaseId) {
      await refundLosingPurchase(env, s);
      return { purchased: false, reason: "pixel owned by other purchase, refunded", pixel_id: pixelId };
    }
  } catch (e) {
    throw new Error("finalize pixel insert: " + e.message);
  }

  const cert = await env.DB.prepare("SELECT certificate_no FROM certificates WHERE pixel_id=?").bind(pixelId).first();
  let certNo = cert?.certificate_no;
  if (!certNo) {
    certNo = "PM-" + String(pixelId).padStart(10,"0") + "-" + hash32(purchaseId).toString(16).toUpperCase();
    try {
      await env.DB.prepare(`
        INSERT INTO certificates(id,pixel_id,certificate_no) VALUES (?,?,?)
      `).bind(crypto.randomUUID(),pixelId,certNo).run();
    } catch (e) {
      const again = await env.DB.prepare("SELECT certificate_no FROM certificates WHERE pixel_id=?").bind(pixelId).first();
      certNo = again?.certificate_no || "";
      if (!certNo) throw e;
    }
  }

  const placeName = String(s.metadata?.place_name || "") || await getPlaceName(geo.lat, geo.lon, env);
  const pdf = await createCertificatePdf({
    pixelId,
    lat: geo.lat,
    lon: geo.lon,
    placeName,
    displayName: p.display_name || "",
    certificateNo: certNo
  });

  let emailed = false;
  if (!wasPaid && p.email) {
    await sendCertificateEmail(env, {
      to: p.email,
      displayName: p.display_name || "",
      pixelId,
      placeName,
      certificateNo: certNo,
      pdf
    });
    emailed = true;
  }

  return { purchased: true, finalized: !wasPaid, pixel_id: pixelId, certificate_no: certNo, emailed };
}

async function handleStripeWebhook(request, env) {
  const sig = request.headers.get("stripe-signature");
  if (!sig) return new Response("Missing Stripe signature",{status:400});
  const raw = await request.text();
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook secret not configured",{status:500});

  if (!(await verifyStripeSignature(raw, sig, secret)))
    return new Response("Invalid signature",{status:400});

  let event;
  try {
    event = JSON.parse(raw);
  } catch (_) {
    return new Response("Invalid JSON",{status:400});
  }

  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    if (s.payment_status !== "paid") {
      console.log("Webhook: session not paid, skipping", s.id, s.payment_status);
      return new Response("ok");
    }
    try {
      const res = await completePaidSession(env, s);
      console.log("Webhook finalize:", JSON.stringify(res));
    } catch (e) {
      console.log("Webhook processing:", e.message);
      return new Response("Webhook processing failed",{status:500});
    }
  }

  return new Response("ok");
}

async function refundLosingPurchase(env, session) {
  const paymentIntent = session.payment_intent;
  if (!paymentIntent) return;
  try {
    const r = await stripeFetch(env, "refunds", {
      method: "POST",
      body: formEncode({
        payment_intent: paymentIntent,
        reason: "duplicate"
      })
    });
    const d = await r.json().catch(() => ({}));
    console.log("Refund initiated:", d.id || d.error?.message || r.status);
  } catch (e) {
    console.log("Refund failed:", e.message);
  }
}

async function verifyStripeSignature(payload, header, secret) {
  const parts = Object.fromEntries(header.split(",").map(x => {
    const i = x.indexOf("=");
    return i > 0 ? [x.slice(0,i), x.slice(i+1)] : [x, ""];
  }));
  const timestamp = parts.t;
  const signatures = header.split(",").filter(x=>x.startsWith("v1=")).map(x=>x.slice(3));
  if (!timestamp || !signatures.length) return false;
  if (!Number.isFinite(Number(timestamp)) || Math.abs(Date.now()/1000 - Number(timestamp)) > 300) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC",key,enc.encode(timestamp+"."+payload));
  const sig64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return signatures.some(s => timingSafeEqual(sig64,s));
}

function timingSafeEqual(a,b) {
  if (a.length !== b.length) return false;
  let x=0;
  for(let i=0;i<a.length;i++) x |= a.charCodeAt(i)^b.charCodeAt(i);
  return x===0;
}

async function router(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return withCors(new Response(null,{status:204}));
  await ensureSchema(env);

  if (url.pathname === "/api/stats") {
    const r = await env.DB.prepare("SELECT COUNT(*) AS sold FROM pixels").first();
    const sold = Number(r?.sold||0);
    return withCors(json({total:TOTAL,sold,remaining:TOTAL-sold}));
  }

  if (url.pathname === "/api/track") {
    const event = String(url.searchParams.get("e") || "").trim();
    if (!event) return withCors(json({ ok: false }));
    const grp = /^[ab]$/.test(url.searchParams.get("ab") || "") ? url.searchParams.get("ab") : "a";
    try {
      await env.DB.prepare(`
        INSERT INTO events(day, grp, event, count) VALUES (?, ?, ?, 1)
        ON CONFLICT(day, grp, event) DO UPDATE SET count = count + 1
      `).bind(utcDay(), grp, event).run();
      return withCors(json({ ok: true }));
    } catch (e) {
      console.log("track:", e.message);
      return withCors(json({ ok: false }));
    }
  }

  if (url.pathname === "/api/events") {
    const day = String(url.searchParams.get("day") || "").trim();
    const last = Math.min(30, Math.max(1, Number(url.searchParams.get("last") || 7)));
    if (day) {
      const rows = await env.DB.prepare(
        "SELECT grp, event, count FROM events WHERE day=? ORDER BY grp, event"
      ).bind(day).all();
      return withCors(json({ day, events: rows.results || [] }));
    }
    const from = utcDay(Date.now() - (last - 1) * 86400000);
    const rows = await env.DB.prepare(
      "SELECT grp, event, SUM(count) AS count FROM events WHERE day>=? GROUP BY grp, event ORDER BY grp, event"
    ).bind(from).all();
    return withCors(json({ last, events: rows.results || [] }));
  }

  if (url.pathname === "/api/clipstats") {
    const day = String(url.searchParams.get("day") || "").trim();
    const last = Math.min(30, Math.max(1, Number(url.searchParams.get("last") || 7)));
    if (day) {
      const rows = await env.DB.prepare(
        "SELECT kind, name, count FROM views WHERE day=? ORDER BY count DESC"
      ).bind(day).all();
      const clips = (rows.results || []).filter((r) => r.kind === "clip");
      const pages = (rows.results || []).filter((r) => r.kind === "page");
      return withCors(json({
        day,
        clips: clips.map((r) => ({ name: r.name.replace(/^\/clips\//, ""), count: r.count })),
        pages: pages.map((r) => ({ name: r.name, count: r.count })),
        totalClips: clips.reduce((s, r) => s + r.count, 0),
        totalPages: pages.reduce((s, r) => s + r.count, 0)
      }));
    }
    const from = utcDay(Date.now() - (last - 1) * 86400000);
    const rows = await env.DB.prepare(
      "SELECT day, kind, SUM(count) AS count FROM views WHERE day>=? GROUP BY day, kind ORDER BY day"
    ).bind(from).all();
    const days = {};
    for (const r of rows.results || []) {
      days[r.day] = days[r.day] || { day: r.day, clips: 0, pages: 0 };
      days[r.day][r.kind] = Number(r.count);
    }
    return withCors(json(Object.values(days)));
  }

  if (url.pathname === "/api/pixels") {
    const minLat = Number(url.searchParams.get("minLat") ?? -90);
    const maxLat = Number(url.searchParams.get("maxLat") ?? 90);
    const minLon = Number(url.searchParams.get("minLon") ?? -180);
    const maxLon = Number(url.searchParams.get("maxLon") ?? 180);
    const limit = Math.min(10000, Math.max(1, Number(url.searchParams.get("limit") || 5000)));
    // Personenbezogene Felder (Anzeigename, Website, Nachricht) nur
    // ausgeben, wenn fuer den Kauf eine Einwilligung vorliegt.
    const fields = `
      p.pixel_id, p.lat, p.lon,
      CASE WHEN pu.consent_given = 1 THEN p.display_name ELSE NULL END AS display_name,
      CASE WHEN pu.consent_given = 1 THEN p.website ELSE NULL END AS website,
      CASE WHEN pu.consent_given = 1 THEN p.message ELSE NULL END AS message,
      CASE WHEN pu.consent_given = 1 THEN p.emoji ELSE NULL END AS emoji
    `;
    let stmt;
    if (minLon <= maxLon) {
      stmt = env.DB.prepare(`
        SELECT ${fields} FROM pixels p
        JOIN purchases pu ON pu.id = p.purchase_id
        WHERE p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ?
        ORDER BY p.pixel_id LIMIT ?
      `).bind(minLat,maxLat,minLon,maxLon,limit);
    } else {
      stmt = env.DB.prepare(`
        SELECT ${fields} FROM pixels p
        JOIN purchases pu ON pu.id = p.purchase_id
        WHERE p.lat BETWEEN ? AND ? AND (p.lon >= ? OR p.lon <= ?)
        ORDER BY p.pixel_id LIMIT ?
      `).bind(minLat,maxLat,minLon,maxLon,limit);
    }
    const rows = await stmt.all();
    return withCors(json({pixels:rows.results||[]}));
  }

  // Agenten: Content-Moderation (AGB §7). Nur mit Admin-Key abrufbar.
  if (url.pathname === "/api/moderation/queue") {
    if (!adminOk(request, env)) return withCors(json({error:"unauthorized"},401));
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 25)));
    const rows = await env.DB.prepare(`
      SELECT p.pixel_id, p.lat, p.lon, p.display_name, p.website, p.message, p.emoji,
             p.created_at, p.moderation_status
      FROM pixels p
      JOIN purchases pu ON pu.id = p.purchase_id
      WHERE pu.consent_given = 1
        AND (TRIM(p.display_name) <> '' OR TRIM(COALESCE(p.website,'')) <> ''
             OR TRIM(COALESCE(p.message,'')) <> '' OR TRIM(COALESCE(p.emoji,'')) <> '')
        AND p.moderation_status = 'pending'
      ORDER BY p.created_at DESC
      LIMIT ?
    `).bind(limit).all();
    return withCors(json({items:rows.results||[]}));
  }

  if (url.pathname === "/api/moderation/review" && request.method === "POST") {
    if (!adminOk(request, env)) return withCors(json({error:"unauthorized"},401));
    const body = await request.json().catch(() => null);
    const pixel_id = Number(body?.pixel_id);
    if (!Number.isInteger(pixel_id) || pixel_id <= 0) return withCors(json({error:"bad pixel_id"},400));
    const status = body?.status === "flagged" ? "flagged" : "ok";
    const flags = (Array.isArray(body?.flags) ? body.flags.filter(Boolean) : []).join(";").slice(0, 500);
    const note = String(body?.note || "").slice(0, 1000);
    const id = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("UPDATE pixels SET moderation_status=?, moderation_updated_at=CURRENT_TIMESTAMP WHERE pixel_id=?")
        .bind(status, pixel_id),
      env.DB.prepare("INSERT INTO moderation_log(id,pixel_id,status,flags,note) VALUES (?,?,?,?,?)")
        .bind(id, pixel_id, status, flags, note)
    ]);
    return withCors(json({ok:true}));
  }

  // Agenten: System-Health (aggregiert, ohne personenbezogene Daten).
  if (url.pathname === "/api/health") {
    const t = utcDay();
    const pendingOld = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM purchases WHERE status='pending' AND created_at < datetime('now','-30 minutes')"
    ).first();
    const paid24h = await env.DB.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor),0) AS rev FROM purchases WHERE status='paid' AND paid_at >= datetime('now','-1 day')"
    ).first();
    const pixelsTotal = await env.DB.prepare("SELECT COUNT(*) AS n FROM pixels").first();
    const expiredRes = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM reservations WHERE expires_at BETWEEN datetime('now','-1 day') AND datetime('now')"
    ).first();
    const yDay = utcDay(Date.now() - 86400000);
    const yv = await env.DB.prepare(
      "SELECT kind, SUM(count) AS c FROM views WHERE day=? GROUP BY kind"
    ).bind(yDay).all();
    const evRows = await env.DB.prepare(
      "SELECT grp, event, SUM(count) AS c FROM events WHERE day>=? GROUP BY grp, event"
    ).bind(utcDay(Date.now() - 6 * 86400000)).all();
    const views = { clip: 0, page: 0 };
    for (const r of yv.results || []) views[r.kind] = Number(r.c);
    return withCors(json({
      utcDay: t,
      pendingOld: Number(pendingOld?.n || 0),
      paid24h: Number(paid24h?.n || 0),
      revenueCents24h: Number(paid24h?.rev || 0),
      pixelsTotal: Number(pixelsTotal?.n || 0),
      expiredReservations24h: Number(expiredRes?.n || 0),
      yesterdayViews: views,
      events7d: (evRows.results || []).map(r => ({ grp: r.grp, event: r.event, count: Number(r.c) })),
      ts: new Date().toISOString()
    }));
  }

  // Agenten: Checkout-Rettung. Findet verwaiste, nie bezahlte Bestellungen
  // (30 Min bis 48h alt, ohne Reminder) und schickt einmalig eine Erinnerung.
  if (url.pathname === "/api/followup/scan" && request.method === "POST") {
    if (!adminOk(request, env)) return withCors(json({error:"unauthorized"},401));
    if (!env.RESEND_API_KEY) return withCors(json({ok:false,error:"no resend key configured"}));
    const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit") || 5)));
    const dry = url.searchParams.get("dry") === "1";
    const rows = await env.DB.prepare(`
      SELECT id, email, display_name, pixel_id, created_at
      FROM purchases
      WHERE status = 'pending'
        AND followup_sent_at IS NULL
        AND email IS NOT NULL AND email <> ''
        AND created_at < datetime('now','-30 minutes')
        AND created_at >= datetime('now','-48 hours')
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(limit).all();
    if (dry) return withCors(json({ ok:true, dry:true, candidates:(rows.results||[]).map(r => ({ email:r.email, name:r.display_name, pixel:r.pixel_id, created:r.created_at })) }));
    const from = env.RESEND_FROM_EMAIL || "PixelMaps <zertifikat@pixelmaps.org>";
    let sent = 0, failed = 0;
    for (const row of (rows.results || [])) {
      try {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `pixelmaps-followup-${row.id}`
          },
          body: JSON.stringify({
            from,
            to: [row.email],
            subject: "Dein Pixel wartet noch auf dich – PixelMaps",
            html: `
              <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#17202a">
                <h1 style="margin-bottom:8px">PIXELMAPS</h1>
                <h2>Dein Pixel wartet noch</h2>
                <p>Hallo ${escapeHtml((row.display_name || "").slice(0,80))},</p>
                <p>du hast letztens einen Checkout auf pixelmaps.org gestartet, aber die Zahlung wurde nicht abgeschlossen. Dein Pixel ist dafür reserviert.</p>
                <p style="font-size:18px"><a href="${env.SITE_URL || "https://pixelmaps.org"}">Jetzt deinen 1-€-Pixel sichern →</a></p>
                <p>Falls du nicht mehr interessiert bist, ignorierst du diese E-Mail einfach – wir melden uns dann nicht wieder.</p>
                <p>Beste Grüße,<br>PixelMaps</p>
              </div>`
          })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { failed++; console.log("followup:", r.status, JSON.stringify(data).slice(0,200)); continue; }
        await env.DB.prepare("UPDATE purchases SET followup_sent_at=CURRENT_TIMESTAMP WHERE id=?").bind(row.id).run();
        sent++;
      } catch (e) {
        failed++; console.log("followup:", e.message);
      }
    }
    return withCors(json({ ok:true, scanned:(rows.results||[]).length, sent, failed }));
  }

  // Agenten: E-Mail-Alerting durch den Worker selbst (Resend-Key bleibt Secret).
  if (url.pathname === "/api/health/alert" && request.method === "POST") {
    if (!adminOk(request, env)) return withCors(json({error:"unauthorized"},401));
    if (!env.RESEND_API_KEY) return withCors(json({ok:false,error:"no resend key configured"}));
    const to = String(env.ALERT_EMAIL || "").trim();
    if (!to) return withCors(json({ok:false,error:"no ALERT_EMAIL configured"}));
    const body = await request.json().catch(() => null);
    const subject = String(body?.subject || "PixelMaps Alert").slice(0, 120);
    const text = String(body?.text || "").slice(0, 4000);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL || "PixelMaps <zertifikat@pixelmaps.org>",
        to: [to],
        subject,
        text: text + "\n\n— PixelMaps Health-Agent"
      })
    });
    const data = await r.json().catch(() => ({}));
    return withCors(json({ ok: r.ok, detail: data }));
  }

  if (url.pathname === "/api/search" && request.method === "GET") {
    const q = String(url.searchParams.get("q") || "").trim().replace(/\s+/g, " ");
    if (q.length < 3 || q.length > 120) return withCors(json({ results: [] }));
    const cacheKey = new Request(`https://pixelmaps-search-cache.invalid/s2/${encodeURIComponent(q.toLowerCase())}`);
    const cache = caches.default;
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return withCors(json({ results: JSON.parse(await cached.text()), cached: true }));
    } catch (_) {}
    const ua = env.NOMINATIM_USER_AGENT || "PixelMaps/1.0 (pixelmaps.org)";
    // Strukturierte Abfrage fuer "Straße Nr. PLZ Stadt" – deutlich praeziser
    // (verhindert, dass Nominatim auf weit entfernte Ortsnamen fallt).
    const m = q.match(/^(.+?)[,\s]+(\d{3,6})[,\s]+(.+)$/);
    let searchUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&accept-language=de,en&q=${encodeURIComponent(q)}`;
    if (m) {
      const structured = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&accept-language=de,en&street=${encodeURIComponent(m[1])}&postalcode=${encodeURIComponent(m[2])}&city=${encodeURIComponent(m[3])}`;
      try {
        const sr = await fetch(structured, { headers: { "User-Agent": ua, "Accept": "application/json" } });
        if (sr.ok) {
          const sd = await sr.json();
          if (Array.isArray(sd) && sd.length > 0) searchUrl = structured;
        }
      } catch (_) {}
    }
    try {
      const r = await fetch(searchUrl, { headers: { "User-Agent": ua, "Accept": "application/json" } });
      if (!r.ok) return withCors(json({ results: [] }));
      const data = await r.json();
      const results = (Array.isArray(data) ? data : [])
        .filter((it) => Number.isFinite(Number(it.lat)) && Number.isFinite(Number(it.lon)) && Number(it.lat) !== 0 && Number(it.lon) !== 0)
        .map((it) => ({
          lat: Number(it.lat),
          lon: Number(it.lon),
          label: String(it.display_name || "").replace(/[\u0000-\u001f<>]/g, "").slice(0, 150),
          type: it.type || "",
          importance: Number(it.importance || 0)
        }));
      try {
        await cache.put(cacheKey, new Response(JSON.stringify(results), {
          headers: { "cache-control": "public, max-age=43200" }
        }));
      } catch (_) {}
      return withCors(json({ results }));
    } catch (e) {
      console.log("Search:", e.message);
      return withCors(json({ results: [] }));
    }
  }

  if (url.pathname === "/api/pixel") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id<0 || id>=TOTAL) return withCors(json({error:"Invalid pixel"},400));
    const p = await env.DB.prepare(`
      SELECT p.pixel_id, p.lat, p.lon,
        CASE WHEN pu.consent_given = 1 THEN p.display_name ELSE NULL END AS display_name,
        CASE WHEN pu.consent_given = 1 THEN p.website ELSE NULL END AS website,
        CASE WHEN pu.consent_given = 1 THEN p.message ELSE NULL END AS message,
        CASE WHEN pu.consent_given = 1 THEN p.emoji ELSE NULL END AS emoji,
        c.certificate_no
      FROM pixels p
      JOIN purchases pu ON pu.id = p.purchase_id
      LEFT JOIN certificates c ON c.pixel_id = p.pixel_id
      WHERE p.pixel_id = ?
    `).bind(id).first();
    const geo = idToGeo(id);
    // Optionaler Adress-Label aus der Suche; kommt nur von Nominatim (/api/search).
    // Plausibilitaet: Label nur uebernehmen, wenn es zur realen Lage passt.
    const label = String(url.searchParams.get("label") || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 150);
    let place_name = label || await getPlaceName(geo.lat, geo.lon, env);
    if (label) {
      const v = await verifyLabel(env, geo.lat, geo.lon, label);
      place_name = v.place;
    }
    return withCors(json({pixel:p || null, geo, place_name}));
  }

  if (url.pathname === "/api/recent") {
    const limitRec = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") || 10)));
    const recentRows = await env.DB.prepare(`
      SELECT p.pixel_id,
        CASE WHEN pu.consent_given = 1 THEN p.display_name ELSE NULL END AS display_name,
        p.created_at
      FROM pixels p
      JOIN purchases pu ON pu.id = p.purchase_id
      ORDER BY p.created_at DESC, p.pixel_id DESC
      LIMIT ?
    `).bind(limitRec).all();
    return withCors(json({pixels: recentRows.results || []}));
  }

  if (url.pathname === "/api/price") {
    const cc = String(url.searchParams.get("cc") || "");
    return withCors(json(getPrice(cc, env)));
  }

  if (url.pathname === "/api/checkout" && request.method === "POST") {
    try {
      return withCors(json(await createCheckout(env, await request.json(), request)));
    } catch(e) {
      return withCors(json({error:e.message},400));
    }
  }

  // Verify bei Rueckkehr: schliesst eine bereits bezahlte Session direkt ueber
  // die Stripe-API ab (Fallback, falls der Webhook nicht/verspaetet ankommt).
  if (url.pathname === "/api/checkout/verify" && request.method === "GET") {
    const sessionId = String(url.searchParams.get("session_id") || "").trim();
    if (!sessionId) return withCors(json({error:"Missing session_id"},400));
    try {
      const r = await stripeFetch(env, "checkout/sessions/" + encodeURIComponent(sessionId));
      const data = await r.json();
      if (!r.ok) return withCors(json({error:data.error?.message || "Stripe error"},400));
      if (data.payment_status !== "paid")
        return withCors(json({ok:true, paid:false, status:data.payment_status}));
      const res = await completePaidSession(env, data);
      return withCors(json({ok:true, paid:true, ...res}));
    } catch(e) {
      return withCors(json({error:e.message},500));
    }
  }

  if (url.pathname === "/api/stripe-webhook" && request.method === "POST")
    return handleStripeWebhook(request,env);

  if (url.pathname === "/api/certificate" && request.method === "GET") {
    const idParam = url.searchParams.get("id");
    const certificateNoParam = String(url.searchParams.get("certificate_no") || "").trim();
    const tokParam = String(url.searchParams.get("tok") || "").trim();
    let row = null;
    let authorized = false;

    if (idParam !== null && idParam !== "") {
      const id = Number(idParam);
      if (!Number.isInteger(id) || id < 0 || id >= TOTAL)
        return withCors(json({error:"Invalid pixel"},400));
      row = await env.DB.prepare(`
        SELECT p.pixel_id, p.lat, p.lon, p.display_name, c.certificate_no
        FROM pixels p JOIN certificates c ON c.pixel_id = p.pixel_id
        WHERE p.pixel_id = ?
      `).bind(id).first();
      // Zugang nur mit Kauf-Nachweis (token = purchase id) oder exakter
      // Zertifikatsnummer. Verhindert, dass jemand die Urkunden anderer
      // Betreiber ueber die Pixel-ID abruft.
      if (row && tokParam) {
        const owner = await env.DB.prepare("SELECT id FROM purchases WHERE pixel_id=? AND id=?").bind(id, tokParam).first();
        authorized = !!owner;
      }
    } else if (certificateNoParam) {
      row = await env.DB.prepare(`
        SELECT p.pixel_id, p.lat, p.lon, p.display_name, c.certificate_no
        FROM pixels p JOIN certificates c ON c.pixel_id = p.pixel_id
        WHERE c.certificate_no = ?
      `).bind(certificateNoParam).first();
      if (row) authorized = true;
    } else {
      return withCors(json({error:"Missing id or certificate_no"},400));
    }

    if (!row) return withCors(json({error:"Certificate not found"},404));
    if (!authorized) return withCors(json({error:"Access to this certificate requires proof of ownership"},403));

    const placeName = await getPlaceName(row.lat, row.lon, env);
    const pdf = await createCertificatePdf({
      pixelId: row.pixel_id,
      lat: row.lat,
      lon: row.lon,
      placeName,
      displayName: row.display_name || "",
      certificateNo: row.certificate_no
    });

    return new Response(pdf, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="pixelmaps-certificate-${row.pixel_id}.pdf"`,
        "cache-control": "public, max-age=31536000, immutable"
      }
    });
  }

  if (url.pathname === "/api/health")
    return withCors(json({ok:true}));

  const shareMatch = url.pathname.match(/^\/p\/(\d{1,12})$/);
  if (shareMatch) {
    const shareId = Number(shareMatch[1]);
    if (Number.isInteger(shareId) && shareId >= 0 && shareId < TOTAL) {
      let og = "";
      try {
        const info = await env.DB.prepare(`
          SELECT p.emoji,
            CASE WHEN pu.consent_given = 1 THEN p.display_name ELSE NULL END AS display_name
          FROM pixels p JOIN purchases pu ON pu.id = p.purchase_id
          WHERE p.pixel_id = ?
        `).bind(shareId).first();
        og = buildOgTags(
          env.SITE_URL || "https://pixelmaps.org",
          shareId,
          info && info.display_name ? String(info.display_name) : "",
          info && info.emoji ? String(info.emoji) : "",
          !!info
        );
      } catch (_) {
        og = "";
      }
      const res = await env.ASSETS.fetch(new URL("/", url));
      if (res.ok) {
        const html = await res.text();
        const out = html.replace("</head>", og + "<script>window.PM_SHARE_PIXEL_ID=" + shareId + ";</script></head>");
        return new Response(out, {
          status: 200,
          headers: {"content-type":"text/html; charset=utf-8"}
        });
      }
      return res;
    }
  }

  if (url.pathname.startsWith("/clips/")) {
    if (request.method === "GET") trackView(env, "clip", url.pathname);
    return serveRange(request, url, env);
  }

  const isPage = request.method === "GET" &&
    !url.pathname.startsWith("/api/") &&
    !url.pathname.startsWith("/clips/") &&
    !/\.([a-z0-9]{2,5})$/i.test(url.pathname);
  if (isPage) trackView(env, "page", url.pathname || "/");

  const res = await env.ASSETS.fetch(request);
  if (isPage) return withAbAssignment(url, request, res);
  return res;
}

// A/B-Auto-Zuteilung: erste HTML-Ladung bekommt einen Cookie (50/50), danach
// bleibt der Besucher in seiner Gruppe. ?v=a|b ueberschreibt nur zum Testen.
function abFromCookie(request) {
  const m = /(?:^|;\s*)pm_ab=([ab])/.exec(request.headers.get("cookie") || "");
  return m ? m[1] : null;
}

function withAbAssignment(url, request, res) {
  const v = url.searchParams.get("v");
  if (/^[ab]$/.test(v || "")) return res;
  if (abFromCookie(request)) return res;
  const group = Math.random() < 0.5 ? "a" : "b";
  const out = new Response(res.body, res);
  out.headers.set("Set-Cookie", `pm_ab=${group}; Path=/; Max-Age=31536000; SameSite=Lax`);
  return out;
}

async function serveRange(request, url, env) {
  const clean = new Request(url.toString());
  const res = await env.ASSETS.fetch(clean);
  if (!res.ok) return res;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const total = bytes.byteLength;
  const type = res.headers.get("content-type") || "application/octet-stream";
  const base = {
    "accept-ranges": "bytes",
    "content-type": type,
    "cache-control": "no-store"
  };
  const range = request.headers.get("Range");
  if (!range) return new Response(bytes, { status: 200, headers: { ...base, "content-length": String(total) } });
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m || (m[1] === "" && m[2] === "")) {
    return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${total}` } });
  }
  let start, end;
  if (m[1] === "") {
    start = Math.max(0, total - Number(m[2]));
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? total - 1 : Number(m[2]);
  }
  if (start > end || start >= total) {
    return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${total}` } });
  }
  end = Math.min(end, total - 1);
  const slice = bytes.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: { ...base, "content-length": String(slice.byteLength), "content-range": `bytes ${start}-${end}/${total}` }
  });
}

function buildOgTags(base, id, name, emoji, sold) {
  const e = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  const title = `Pixel #${id} · One World, One Billion Pixels`;
  const desc = name
    ? `Gesichert von ${name}${emoji ? " " + emoji : ""} – einer von einer Milliarde Pixeln auf der Weltkarte.`
    : "Dieser Pixel wurde gesichert – einer von einer Milliarde Pixeln auf der Weltkarte.";
  const url = `${base}/p/${id}`;
  const img = `${base}/og-image.png`;
  const ld = JSON.stringify({
    "@context":"https://schema.org",
    "@type":"Product",
    "name":`Pixel #${id}`,
    "description":desc,
    "image":img,
    "url":url,
    "offers":{"@type":"Offer","price":"1","priceCurrency":"EUR",
      "availability": sold ? "https://schema.org/SoldOut" : "https://schema.org/InStock"}
  }).replace(/</g,"\\u003c");
  return [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="PixelMaps">',
    '<meta property="og:locale" content="de_DE">',
    `<meta property="og:title" content="${e(title)}">`,
    `<meta property="og:description" content="${e(desc)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${img}">`,
    `<link rel="canonical" href="${url}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${e(title)}">`,
    `<meta name="twitter:description" content="${e(desc)}">`,
    `<meta name="twitter:image" content="${img}">`,
    `<script type="application/ld+json">${ld}</script>`,
    ""
  ].join("\n    ");
}

async function createCertificatePdf({ pixelId, lat, lon, placeName, displayName, certificateNo }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([842, 595]);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdfDoc.embedFont(StandardFonts.Courier);
  const monoBold = await pdfDoc.embedFont(StandardFonts.CourierBold);

  const W = 842;
  const H = 595;

  const bg = rgb(0.018, 0.035, 0.055);
  const panel = rgb(0.025, 0.055, 0.075);
  const green = rgb(0.20, 1.00, 0.55);
  const cyan = rgb(0.20, 0.88, 1.00);
  const white = rgb(0.92, 0.98, 1.00);
  const muted = rgb(0.47, 0.62, 0.68);
  const grid = rgb(0.10, 0.30, 0.34);
  const dark = rgb(0.04, 0.10, 0.13);

  const safe = (value) => String(value ?? "")
    .replace(/ä/g, "ae").replace(/Ä/g, "Ae")
    .replace(/ö/g, "oe").replace(/Ö/g, "Oe")
    .replace(/ü/g, "ue").replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss")
    .replace(/°/g, " deg")
    .replace(/[^\x20-\x7E]/g, "");

  const owner = safe(displayName || "PIXELMAPS HOLDER");
  const location = safe(placeName || `Grid ${lat.toFixed(5)} deg, ${lon.toFixed(5)} deg`);
  const dateText = new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).toUpperCase();

  // Deep space background.
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: bg });

  // Subtle technical grid.
  for (let x = 22; x < W; x += 28) {
    page.drawLine({
      start: { x, y: 18 },
      end: { x, y: H - 18 },
      color: grid,
      thickness: 0.35,
      opacity: 0.18
    });
  }
  for (let y = 20; y < H; y += 28) {
    page.drawLine({
      start: { x: 18, y },
      end: { x: W - 18, y },
      color: grid,
      thickness: 0.35,
      opacity: 0.18
    });
  }

  // Layered neon frame.
  page.drawRectangle({
    x: 14, y: 14, width: W - 28, height: H - 28,
    borderColor: cyan, borderWidth: 1.2, borderOpacity: 0.65
  });
  page.drawRectangle({
    x: 20, y: 20, width: W - 40, height: H - 40,
    borderColor: green, borderWidth: 0.7, borderOpacity: 0.38
  });

  // Corner marks.
  const corner = 24;
  const mark = (x, y, sx, sy) => {
    page.drawLine({ start: {x, y}, end: {x: x + sx * corner, y}, color: green, thickness: 2.2, opacity: 0.95 });
    page.drawLine({ start: {x, y}, end: {x, y: y + sy * corner}, color: cyan, thickness: 2.2, opacity: 0.95 });
  };
  mark(28, H - 28, 1, -1);
  mark(W - 28, H - 28, -1, -1);
  mark(28, 28, 1, 1);
  mark(W - 28, 28, -1, 1);

  // Header.
  page.drawText("PIXELMAPS", {
    x: 46, y: 520, size: 30, font: bold, color: white
  });
  page.drawText("WORLD RECORD CERTIFICATE", {
    x: 47, y: 486, size: 18, font: monoBold, color: green
  });
  page.drawText("ONE PIXEL. ONE PLACE. YOUR WORLD.", {
    x: 48, y: 463, size: 8.5, font: mono, color: muted
  });

  // Certificate identity strip.
  page.drawRectangle({
    x: 46, y: 420, width: 438, height: 24,
    color: panel, borderColor: grid, borderWidth: 0.6
  });
  page.drawText(`CERTIFICATE // ${safe(certificateNo)}`, {
    x: 56, y: 428, size: 8.5, font: monoBold, color: cyan
  });

  // Main owner block.
  page.drawText("THIS PIXEL BELONGS TO", {
    x: 48, y: 381, size: 8, font: monoBold, color: muted
  });
  page.drawText(owner.toUpperCase().slice(0, 34), {
    x: 48, y: 348, size: 27, font: bold, color: white
  });
  page.drawText(location.toUpperCase().slice(0, 44), {
    x: 48, y: 322, size: 11, font: monoBold, color: green
  });

  // Data cards.
  const card = (x, y, w, label, value, valueColor = white) => {
    page.drawRectangle({
      x, y, width: w, height: 55,
      color: dark, borderColor: grid, borderWidth: 0.7
    });
    page.drawText(label, {
      x: x + 10, y: y + 39, size: 7, font: monoBold, color: muted
    });
    page.drawText(value.slice(0, 28), {
      x: x + 10, y: y + 18, size: 10.5, font: monoBold, color: valueColor
    });
  };

  card(48, 248, 210, "PIXEL ID", String(pixelId), cyan);
  card(270, 248, 214, "DATE", dateText, green);
  card(48, 181, 210, "LATITUDE", `${lat.toFixed(5)} deg`, white);
  card(270, 181, 214, "LONGITUDE", `${lon.toFixed(5)} deg`, white);

  // Statement.
  page.drawText("ONE OF 1,000,000,000 GEOGRAPHIC PIXELS", {
    x: 48, y: 142, size: 8.5, font: monoBold, color: cyan
  });
  page.drawText("Registered within the PixelMaps global one-billion-pixel grid.", {
    x: 48, y: 121, size: 9.5, font, color: white
  });
  page.drawText("PixelMaps is pursuing recognition of this project as a world record.", {
    x: 48, y: 101, size: 8.5, font, color: muted
  });

  // Globe / Earth panel.
  const cx = 665;
  const cy = 302;
  const r = 145;

  // Glow rings.
  for (let i = 5; i >= 1; i--) {
    page.drawCircle({
      x: cx, y: cy, size: r + i * 9,
      borderColor: i % 2 ? cyan : green,
      borderWidth: 1.1,
      borderOpacity: 0.045 + (6 - i) * 0.018
    });
  }

  page.drawCircle({
    x: cx, y: cy, size: r,
    color: rgb(0.02, 0.09, 0.12),
    borderColor: cyan, borderWidth: 1.6, borderOpacity: 0.9
  });

  // Globe longitude/latitude lines.
  for (let i = -3; i <= 3; i++) {
    const dx = (i / 3) * r;
    const rx = Math.sqrt(Math.max(0, r * r - dx * dx));
    page.drawEllipse({
      x: cx + dx, y: cy,
      xScale: Math.max(5, rx * 0.30),
      yScale: r,
      borderColor: grid, borderWidth: 0.8, borderOpacity: 0.72
    });
  }
  for (let i = -2; i <= 2; i++) {
    const dy = (i / 2) * r * 0.72;
    const ry = Math.sqrt(Math.max(0, r * r - dy * dy));
    page.drawEllipse({
      x: cx, y: cy + dy,
      xScale: r,
      yScale: Math.max(4, ry * 0.22),
      borderColor: grid, borderWidth: 0.8, borderOpacity: 0.72
    });
  }

  // Stylized continent silhouettes / landmasses.
  const landColor = rgb(0.05, 0.24, 0.20);
  page.drawSvgPath("M 0,30 L 35,58 L 50,42 L 74,48 L 90,30 L 82,10 L 56,8 L 43,-5 L 20,2 L 8,18 Z", {
    x: cx - 116, y: cy + 34, color: landColor, opacity: 0.88
  });
  page.drawSvgPath("M 0,18 L 24,35 L 50,31 L 67,16 L 58,-8 L 36,-18 L 18,-7 L 4,-20 L -10,-5 Z", {
    x: cx - 25, y: cy - 4, color: landColor, opacity: 0.88
  });
  page.drawSvgPath("M 0,12 L 18,27 L 42,22 L 60,6 L 50,-10 L 27,-15 L 8,-6 Z", {
    x: cx + 45, y: cy + 28, color: landColor, opacity: 0.82
  });
  page.drawSvgPath("M 0,12 L 18,27 L 33,21 L 42,2 L 28,-10 L 10,-6 Z", {
    x: cx + 48, y: cy - 42, color: landColor, opacity: 0.82
  });

  // Geographic pixel marker with neon halo.
  const mx = cx + Math.max(-92, Math.min(92, (lon / 180) * 92));
  const my = cy + Math.max(-108, Math.min(108, (lat / 90) * 108));

  for (let s = 15; s >= 4; s -= 3) {
    page.drawCircle({
      x: mx, y: my, size: s,
      borderColor: green, borderWidth: 1,
      borderOpacity: 0.06 + (16 - s) * 0.018
    });
  }
  page.drawRectangle({
    x: mx - 5, y: my - 5, width: 10, height: 10,
    color: green, borderColor: white, borderWidth: 0.7
  });
  page.drawLine({
    start: {x: mx, y: my + 8},
    end: {x: mx, y: my + 24},
    color: green, thickness: 1.2, opacity: 0.95
  });
  page.drawText("YOUR PIXEL", {
    x: mx + 11, y: my + 20, size: 7.5, font: monoBold, color: green
  });

  // Globe labels.
  page.drawText("GLOBAL GRID", {
    x: 575, y: 134, size: 8, font: monoBold, color: muted
  });
  page.drawText("1,000,000,000", {
    x: 575, y: 113, size: 18, font: monoBold, color: white
  });
  page.drawText("GEOGRAPHIC PIXELS", {
    x: 575, y: 95, size: 7.5, font: monoBold, color: cyan
  });

  // Footer.
  page.drawLine({
    start: {x: 48, y: 67}, end: {x: 794, y: 67},
    color: grid, thickness: 0.7, opacity: 0.8
  });
  page.drawText("PIXELMAPS WORLD RECORD PROJECT", {
    x: 48, y: 46, size: 7.5, font: monoBold, color: muted
  });
  page.drawText("pixelmaps.org", {
    x: 700, y: 46, size: 7.5, font: monoBold, color: cyan
  });

  return await pdfDoc.save();
}
export default { fetch: router };
