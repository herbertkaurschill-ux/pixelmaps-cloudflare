#!/usr/bin/env node
// Traegt einen Gemini-Key in Jarvis' api_keys.json ein - ohne die uebrigen
// Einstellungen zu verlieren. Ein Backup wird geschrieben.
//
//   node scripts/campaign/set-gemini-key.mjs AIzaSy...
//   node scripts/campaign/set-gemini-key.mjs           # fragt interaktiv
//   node scripts/campaign/set-gemini-key.mjs --check   # nur pruefen
import fs from "fs";
import path from "path";
import readline from "readline";

const KEY_FILE = "/Users/up/Desktop/jarvis-mark53/config/api_keys.json";

function readline_ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((res) => rl.question(question, (a) => (rl.close(), res(a.trim()))));
}

// KEINE Formatpruefung. Es gab eine Annahme "AIza + 39 Zeichen", die sich
// als falsch erwiesen hat: gueltige Google-Keys haben auch andere Formate.
// Ein Key wird hier nur auf Leerheit geprueft - die Funktion beweist der API.
function validate(k) {
  if (!k || k.length < 20) return "zu kurz (unter 20 Zeichen)";
  if (/\s/.test(k)) return "enthaelt Leerzeichen - Key ohne Leerzeichen kopieren";
  return null;
}

function load() {
  if (!fs.existsSync(KEY_FILE)) {
    console.log(`${KEY_FILE} existiert nicht - wird neu angelegt.`);
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
  } catch (e) {
    console.log(`FEHLER: ${KEY_FILE} ist kein gueltiges JSON: ${e.message}`);
    console.log("Ich fasse die Datei nicht an, um nichts zu zerstoeren.");
    process.exit(1);
  }
}

(async () => {
  const cfg = load();
  const current = cfg.gemini_api_key || "";
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  console.log(`Datei: ${KEY_FILE}`);
  console.log(
    `Aktuell: ${current ? current.slice(0, 8) + "…" : "(leer)"}`
  );
  const preserved = Object.entries(cfg).filter(
    ([k, v]) => k !== "gemini_api_key" && typeof v !== "object"
  );
  if (preserved.length) {
    console.log(`Bleiben erhalten: ${preserved.map(([k]) => k).join(", ")}`);
  }

  if (process.argv.includes("--check")) {
    const e = validate(current);
    console.log(e ? `Problem: ${e}` : "Key ist nicht leer.");
    console.log("Verbindlich pruefen:  node scripts/campaign/gemini-test.mjs");
    return;
  }

  const key = args[0] || (await readline_ask("Gemini API Key: "));
  const err = validate(key);
  if (err) {
    console.log(`\nAbgelehnt: ${err}`);
    console.log("Key holen: https://aistudio.google.com/apikey");
    process.exit(1);
  }

  if (key === current) {
    console.log("\nUnveraendert - nicht geschrieben.");
    return;
  }

  const bak = KEY_FILE + ".bak";
  fs.copyFileSync(KEY_FILE, bak);
  cfg.gemini_api_key = key;
  fs.writeFileSync(KEY_FILE, JSON.stringify(cfg, null, 2) + "\n");
  fs.chmodSync(KEY_FILE, 0o600);

  console.log(`\nBackup:      ${bak}`);
  console.log(`Eingetragen: ${key.slice(0, 8)}… (${key.length} Zeichen)`);
  console.log("Berechtigung: 600 (nur der Besitzer kann lesen)");
  console.log(`\nNaechster Schritt:  node scripts/campaign/gemini-test.mjs`);
})();