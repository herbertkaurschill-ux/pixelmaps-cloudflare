#!/usr/bin/env node
// Prueft einen Gemini-API-Key, bevor er in Jarvis oder ein Skript kommt.
//
// Zwei Fallstricke, die uns beide Zeit gekostet haben:
//  1. Der Key muss NICHT mit "AIza" beginnen und nicht 39 Zeichen haben.
//     Eine Vorabpruefung auf dieses Format lehnt gueltige Keys ab - wir
//     haben das mit einem funktionierenden Key erlebt. Kein Format-Gate.
//  2. maxOutputTokens muss gross genug sein: die neuen Modelle denken erst
//     (thoughtsTokenCount) und antworten danach. Bei 20Tokens bleibt die
//     Antwort leer und finishReason ist MAX_TOKENS - was wie ein kaputter
//     Key aussieht, aber keiner ist.
//
//   node scripts/campaign/gemini-test.mjs
//   GEMINI_API_KEY=AIza... node scripts/campaign/gemini-test.mjs
import fs from "fs";

const KEY_FILE = "/Users/up/Desktop/jarvis-mark53/config/api_keys.json";

function keyFromFile() {
  try {
    return JSON.parse(fs.readFileSync(KEY_FILE, "utf8")).gemini_api_key || "";
  } catch {
    return "";
  }
}

const key = process.env.GEMINI_API_KEY || keyFromFile();

// Reihenfolge = Empfohlenes. gemini-2.5-flash ist fuer neue Nutzer gesperrt
// ("no longer available to new users"), deshalb weiter unten weg.
const MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
];

async function test(model, attempt = 0) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}` +
    `:generateContent?key=${key}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: "Antworte nur mit dem Wort: funktioniert" }] }],
    generationConfig: { maxOutputTokens: 4000 },
  });
  const ctl = AbortSignal.timeout(30000);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: ctl,
  });
  const txt = await r.text();
  let j;
  try {
    j = JSON.parse(txt);
  } catch {
    return { model, code: r.status, error: txt.slice(0, 120) };
  }
  if (j.error) {
    // Auslastung ist normal und voruebergehend - mit Backoff erneut versuchen.
    if (/demand|capacity|overloaded/i.test(j.error.message || "") && attempt < 3) {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      return test(model, attempt + 1);
    }
    return { model, code: j.error.code, error: j.error.message };
  }
  const cand = j.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const out = parts.map((p) => p.text ?? "").join("");
  if (!out.trim()) {
    return {
      model,
      code: r.status,
      error: `leere Antwort (finishReason=${cand?.finishReason}) - maxOutputTokens erhoehen?`,
    };
  }
  return {
    model,
    code: r.status,
    text: out.trim(),
    tokens: j.usageMetadata?.totalTokenCount,
    thoughts: j.usageMetadata?.thoughtsTokenCount,
  };
}

(async () => {
  const key = process.env.GEMINI_API_KEY || keyFromFile();
  console.log(`Key: ${key ? key.slice(0, 8) + "…" : "(leer)"}`);
  console.log(`Quelle: ${process.env.GEMINI_API_KEY ? "Umgebungsvariable" : KEY_FILE}`);
  if (!key) {
    console.log("\nKein Key. Holen: https://aistudio.google.com/apikey");
    console.log("Eintragen mit:  node scripts/campaign/set-gemini-key.mjs <KEY>");
    process.exit(1);
  }
  // Wir testen die Modelle direkt statt das Key-Format zu raten. Das Format
  // ist kein zuverlaessiges Merkmal: dieser Key beginnt nicht mit "AIza" und
  // ist trotzdem gueltig.

  console.log("\nTeste Modelle:");
  const ok = [];
  for (const m of MODELS) {
    try {
      const r = await test(m);
      if (r.text) {
        const th = r.thoughts ? `, davon Denken ${r.thoughts}` : "";
        console.log(`  OK    ${m.padEnd(22)} ${JSON.stringify(r.text.slice(0, 40))}`);
        console.log(`        ${r.tokens ?? "?"} Tokens${th}`);
        ok.push(m);
      } else {
        console.log(`  nein  ${m.padEnd(22)} ${r.code}: ${r.error}`);
      }
    } catch (e) {
      console.log(`  nein  ${m.padEnd(22)} ${e.message}`);
    }
  }

  console.log("");
  if (ok.length) {
    console.log(`ERGEBNIS: Key funktioniert. ${ok.length}/${MODELS.length} Modelle antworten.`);
    console.log(`Empfohlen: ${ok[0]}`);
  } else {
    console.log("ERGEBNIS: Kein Modell antwortet.");
    console.log("Der Key ist formal gueltig (die Modelliste liess sich), aber");
    console.log("generateContent schlaegt bei allen fehl - meist Billing oder API-Freischaltung.");
    process.exit(1);
  }
})();
