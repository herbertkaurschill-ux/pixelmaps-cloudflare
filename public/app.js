const soldEl = document.getElementById("sold");
const bar = document.getElementById("bar");
const coords = document.getElementById("coords");
const mapStatus = document.getElementById("mapStatus");
const modal = document.getElementById("modal");
const closeBtn = document.getElementById("close");
const form = document.getElementById("buyForm");
const errorEl = document.getElementById("formError");
const ownerEl = document.getElementById("owner");
const pixelMeta = document.getElementById("pixelMeta");

const COLS = 40000;
const ROWS = 25000;
const TOTAL = 1000000000;
const CELL_LON = 360 / COLS;
const CELL_LAT = 180 / ROWS;

let selected = null;
let selectedLayer = null;
let ownedLayers = [];
let loadTimer = null;
let lastBoundsKey = "";

function idToGeo(id) {
  const row = Math.floor(id / COLS);
  const col = id % COLS;

  return {
    lat: 90 - (row + 0.5) * CELL_LAT,
    lon: -180 + (col + 0.5) * CELL_LON,
    row,
    col
  };
}

function geoToId(lat, lon) {
  const clampedLat = Math.max(-90, Math.min(90, lat));

  let x = (lon + 180) / 360;
  x = ((x % 1) + 1) % 1;

  const col = Math.min(
    COLS - 1,
    Math.floor(x * COLS)
  );

  const row = Math.min(
    ROWS - 1,
    Math.max(
      0,
      Math.floor((90 - clampedLat) / 180 * ROWS)
    )
  );

  return row * COLS + col;
}

function idToBounds(id) {
  const {row, col} = idToGeo(id);

  const north = 90 - row * CELL_LAT;
  const south = north - CELL_LAT;

  const west = -180 + col * CELL_LON;
  const east = west + CELL_LON;

  return [
    [south, west],
    [north, east]
  ];
}

function locationText(lat, lon) {
  const latText =
    `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"}`;

  const lonText =
    `${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? "E" : "W"}`;

  return `${latText} · ${lonText}`;
}

const map = L.map("map", {
  worldCopyJump: true,
  minZoom: 1,
  maxZoom: 19,
  zoomControl: true,
  attributionControl: true
}).setView([20, 0], 2);

L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
  }
).addTo(map);

map.on("mousemove", e => {
  coords.textContent =
    locationText(e.latlng.lat, e.latlng.lng);
});

map.on("mouseout", () => {
  coords.textContent = selected
    ? `Pixel ${selected.pixel_id.toLocaleString()}`
    : "Move over the map";
});

map.on("click", e => {
  selectAt(e.latlng.lat, e.latlng.lng);
});

map.on("moveend", scheduleLoadPixels);
map.on("zoomend", scheduleLoadPixels);

function drawSelected() {
  if (selectedLayer) {
    selectedLayer.remove();
    selectedLayer = null;
  }

  if (!selected) return;

  selectedLayer = L.rectangle(
    idToBounds(selected.pixel_id),
    {
      color: "#111",
      weight: 2,
      fillColor: "#8cff9b",
      fillOpacity: 0.38,
      interactive: false
    }
  ).addTo(map);
}

function clearOwnedLayers() {
  for (const layer of ownedLayers) {
    layer.remove();
  }

  ownedLayers = [];
}

async function loadPixels() {
  const b = map.getBounds();

  const key = [
    b.getSouth(),
    b.getNorth(),
    b.getWest(),
    b.getEast(),
    map.getZoom()
  ]
    .map(v => Math.round(v * 100) / 100)
    .join(",");

  if (key === lastBoundsKey) return;

  lastBoundsKey = key;

  try {
    const params = new URLSearchParams({
      minLat: String(
        Math.max(-90, b.getSouth())
      ),
      maxLat: String(
        Math.min(90, b.getNorth())
      ),
      minLon: String(b.getWest()),
      maxLon: String(b.getEast()),
      limit: "5000"
    });

    const r = await fetch(
      `/api/pixels?${params}`
    );

    const d = await r.json();

    clearOwnedLayers();

    for (const p of d.pixels || []) {
      const layer = L.rectangle(
        idToBounds(p.pixel_id),
        {
          color: "#4de56b",
          weight: map.getZoom() >= 8 ? 1 : 0,
          fillColor: "#52f477",
          fillOpacity:
            map.getZoom() >= 8 ? 0.72 : 0.55,

          // Wichtig:
          // Gekaufte Pixel fangen keine Karten-Klicks ab.
          interactive: false
        }
      ).addTo(map);

      ownedLayers.push(layer);
    }

    mapStatus.textContent =
      d.pixels?.length >= 5000
        ? "5,000+ owned pixels visible in this area"
        : `${d.pixels?.length || 0} owned pixels visible in this area`;

  } catch (e) {
    mapStatus.textContent =
      "Could not load ownership data";
  }
}

function scheduleLoadPixels() {
  clearTimeout(loadTimer);

  loadTimer = setTimeout(
    loadPixels,
    180
  );
}

async function stats() {
  try {
    const r = await fetch(
      "/api/stats"
    );

    const s = await r.json();

    soldEl.textContent =
      Number(s.sold || 0).toLocaleString();

    bar.style.width =
      `${Math.min(
        100,
        Number(s.sold || 0) /
        Number(s.total || TOTAL) *
        100
      )}%`;

  } catch (_) {}
}

async function selectAt(lat, lon) {
  const pixelId = geoToId(lat, lon);

  selected = {
    lat,
    lon,
    pixel_id: pixelId
  };

  drawSelected();

  await openModal();
}

async function openModal() {
  modal.classList.remove("hidden");

  errorEl.textContent = "";

  form.reset();

  ownerEl.classList.add("hidden");
  form.classList.remove("hidden");

  pixelMeta.textContent =
    "Checking availability…";

  try {
    const r = await fetch(
      `/api/pixel?id=${selected.pixel_id}`
    );

    const d = await r.json();

    const geo =
      d.geo ||
      idToGeo(selected.pixel_id);

    /*
     * ORT
     *
     * Der Worker kann den ermittelten
     * Ortsnamen liefern.
     */
    const placeName =
      d.place_name ||
      d.place ||
      d.location ||
      null;

    if (placeName) {
      document.getElementById(
        "location"
      ).textContent =
        `Pixel ${selected.pixel_id.toLocaleString()} · ${placeName}`;
    } else {
      document.getElementById(
        "location"
      ).textContent =
        `Pixel ${selected.pixel_id.toLocaleString()} · Ort wird ermittelt…`;
    }

    pixelMeta.textContent =
      `Grid cell: ${COLS.toLocaleString()} × ${ROWS.toLocaleString()} · approx. ${CELL_LON.toFixed(4)}° × ${CELL_LAT.toFixed(4)}° at the equator`;

    /*
     * BEREITS GEKAUFT
     *
     * Wenn der Worker einen bestehenden
     * Pixel zurückgibt, wird kein Kauf-
     * Formular angezeigt.
     */
    if (d.pixel) {
      ownerEl.classList.remove("hidden");

      const ownerName =
        esc(d.pixel.display_name);

      const website =
        d.pixel.website
          ? ` · <a href="${esc(
              d.pixel.website
            )}" target="_blank" rel="noopener">website</a>`
          : "";

      ownerEl.innerHTML =
        `Owned by <strong>${ownerName}</strong>${website}`;

      form.classList.add("hidden");

      pixelMeta.textContent =
        placeName
          ? `Location: ${esc(placeName)}`
          : `Pixel ${selected.pixel_id.toLocaleString()} is already owned.`;

      return;
    }

    /*
     * PIXEL FREI
     *
     * Normales Kauf-Formular anzeigen.
     */
    form.classList.remove("hidden");
    ownerEl.classList.add("hidden");

  } catch (err) {
    errorEl.textContent =
      "Could not check pixel availability.";

    console.error(err);
  }
}

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    m =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[m])
  );
}

function closeModal() {
  modal.classList.add("hidden");
}

closeBtn.addEventListener(
  "click",
  closeModal
);

modal.addEventListener(
  "click",
  e => {
    if (e.target === modal) {
      closeModal();
    }
  }
);

document.addEventListener(
  "keydown",
  e => {
    if (e.key === "Escape") {
      closeModal();
    }
  }
);

form.addEventListener(
  "submit",
  async e => {
    e.preventDefault();

    errorEl.textContent = "";

    const fd =
      new FormData(form);

    /*
     * Pixel-ID merken.
     *
     * Nach der Stripe-Zahlung können wir
     * damit die Urkunde öffnen.
     */
    localStorage.setItem(
      "pixelmaps_last_purchase_pixel_id",
      String(selected.pixel_id)
    );

    try {
      const r = await fetch(
        "/api/checkout",
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json"
          },

          body: JSON.stringify({
            pixel_id:
              selected.pixel_id,

            display_name:
              fd.get("display_name"),

            email:
              fd.get("email"),

            website:
              fd.get("website"),

            message:
              fd.get("message")
          })
        }
      );

      const d = await r.json();

      if (!r.ok) {
        throw new Error(
          d.error ||
          "Checkout failed"
        );
      }

      window.location.href =
        d.url;

    } catch (err) {
      errorEl.textContent =
        err.message;
    }
  }
);

/*
 * Rückkehr von Stripe
 */
const qs =
  new URLSearchParams(
    location.search
  );

if (qs.get("success") === "1") {

  mapStatus.textContent =
    "Payment received — your PixelMaps ownership is being confirmed.";

  const lastPixelId =
    localStorage.getItem(
      "pixelmaps_last_purchase_pixel_id"
    );

  /*
   * URL sauber machen.
   */
  history.replaceState(
    {},
    "",
    location.pathname
  );

  /*
   * Wenn eine Pixel-ID vorhanden ist,
   * versuchen wir die Urkunde zu öffnen.
   *
   * Kurze Verzögerung, damit der Stripe-
   * Webhook Zeit hat, den Kauf und die
   * Urkunde in D1 einzutragen.
   */
  if (lastPixelId) {

    setTimeout(() => {

      window.location.href =
        `/api/certificate?id=${encodeURIComponent(
          lastPixelId
        )}`;

    }, 2500);
  }

} else if (
  qs.get("cancelled") === "1"
) {

  mapStatus.textContent =
    "Checkout cancelled. The pixel is still available until someone else buys it.";

  history.replaceState(
    {},
    "",
    location.pathname
  );
}

stats();
scheduleLoadPixels();

setInterval(
  stats,
  15000
);