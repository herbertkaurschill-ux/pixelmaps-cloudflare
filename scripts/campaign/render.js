// Kampagnen-Renderer: rendert alle Videos aus videos.json lokal via clipmap.py.
// Nutzung: node scripts/campaign/render.js   (Parallelitaet via P=4)
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(__dirname, "..", "..");
const PY = path.join(BASE, "scripts", "clipmap.py");
const VIDEOS = JSON.parse(fs.readFileSync(path.join(__dirname, "videos.json"), "utf8"));
const OUT = path.join(BASE, "public", "clips", "campaign");
const TMP = os.tmpdir();
const P = Math.max(1, parseInt(process.env.P || "5", 10));

fs.mkdirSync(OUT, { recursive: true });

function genFile(id, obj) {
  const f = path.join(TMP, `cp_${id}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

function render(v, out) {
  return new Promise((resolve, reject) => {
    const args = [PY, "--out", out];
    let cleanup = [];
    if (v.kind === "scenes") {
      const f = genFile(v.id, {
        duration: v.duration,
        music: v.music,
        brand: v.brand,
        cities: v.cities,
        scenes: v.scenes,
        lang: v.lang || "de"
      });
      cleanup.push(f);
      args.push("--scenes", f);
    } else {
      const f = genFile(v.id, {
        eyebrow: v.eyebrow,
        claim: v.claim,
        caption: v.caption
      });
      cleanup.push(f);
      args.push(
        "--claim", f,
        "--duration", String(v.duration || 6),
        "--lang", v.lang || "de",
        "--variant", v.variant || "classic"
      );
      if (v.focus) args.push("--focus", v.focus);
    }
    const p = spawn("python3", args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("close", (code) => {
      cleanup.forEach((x) => { try { fs.unlinkSync(x); } catch (_) {} });
      code === 0 ? resolve() : reject(new Error(`render ${v.id} exited ${code}`));
    });
  });
}

(async () => {
  const only = [];
  const oi = process.argv.indexOf("--only");
  if (oi > -1) only.push(...process.argv[oi + 1].split(",").map((s) => s.trim()).filter(Boolean));
  let queue = only.length
    ? VIDEOS.filter((v) => only.includes(v.id))
    : VIDEOS.filter((v) => !fs.existsSync(path.join(OUT, `${v.id}.mp4`)));
  const done = VIDEOS.length - queue.length;
  if (done > 0) console.log(`Ueberspringe ${done} bereits gerenderte Videos.`);
  console.log(`Rendere ${queue.length} Videos (Parallelitaet ${P}) ...`);
  let idx = 0;
  const workers = Array.from({ length: P }, async () => {
    while (idx < queue.length) {
      const v = queue[idx++];
      const t0 = Date.now();
      await render(v, path.join(OUT, `${v.id}.mp4`));
      console.log(`[${idx}/${queue.length}] ${v.id} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  });
  await Promise.all(workers);
  console.log("FERTIG. Ausgabe: " + OUT);
  console.log("Manifest: " + path.join(BASE, "scripts", "campaign", "videos.json"));
})().catch((e) => { console.error(e.message); process.exit(1); });