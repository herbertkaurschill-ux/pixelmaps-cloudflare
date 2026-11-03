#!/bin/zsh
export PATH="/usr/local/bin:/opt/homebrew/bin:/Users/up/.docker/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Python-Interpreter festlegen: /usr/bin/python3 (Command Line Tools) wird von
# macOS unter launchd ohne Desktop-Zugriffsrecht blockiert ("Operation not
# permitted"), Homebrew-Python darf. Deshalb ist clipmap.py seit 05.10. still.
PY="/opt/homebrew/bin/python3.11"
[ -x "$PY" ] || PY="$(command -v python3)"

# publish-day.sh – baut die täglichen Kurzclips (KI-Bild + Ken Burns + Stimme),
# deployed sie auf pixelmaps.org und pusht die Beiträge an Buffer.
PROJ="$HOME/Desktop/pixelmaps-cloudflare"
AGENT="$HOME/.n8n/agent/agent.js"
DATE=$(date +%F)
YR=$(date +%Y)
MO=$(date +%m)
POSTS="$HOME/.n8n/content/$YR/$MO/$DATE/posts.json"
CLIPDIR="$PROJ/public/clips/generated"
LOG="$HOME/.n8n/content/review/publish-day.log"

# Eine Sprache pro Tag (de,en,es,fr,it,pt,tr,ru,hi,zh), damit Hook, Video und
# Caption dieselbe Sprache sprechen. Rotationslogik: campaign/post-text.cjs.
POST_LANG=$(node -e "const t=require('$PROJ/scripts/campaign/post-text.cjs'); console.log(t.langForDate('$DATE'))")
echo "Sprache heute: $POST_LANG"

mkdir -p "$CLIPDIR"
exec >>"$LOG" 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') publish-day $DATE ==="

if [ ! -f "$POSTS" ]; then
  echo "posts.json fehlt -> generiere (review-only) im n8n-Container ..."
  docker exec n8n node /home/node/.n8n/agent/agent.js || { echo "FEHLGESCHLAGEN: Generierung"; exit 1; }
fi
[ -f "$POSTS" ] || { echo "FEHLGESCHLAGEN: kein posts.json"; exit 1; }

# posts.json auf die Tagessprache umschreiben: agent.js pusht genau diesen
# Text, damit Video und Caption nicht auseinanderlaufen. Backup daneben.
if ! node -e '
const fs = require("fs");
const file = process.argv[1];
const t = require(process.argv[2]);
const lang = t.langForDate(process.argv[3]);
const j = JSON.parse(fs.readFileSync(file, "utf8"));
fs.writeFileSync(file.replace(/\.json$/, ".pre-intl.json"), JSON.stringify(j, null, 2));
for (const p of j.posts || []) {
  const b = t.buildPost({ platform: p.platform, lang, date: process.argv[3] });
  p.hook = b.text;
  p.caption = "";
  p.cta = "";
  p.title = b.title;
  p.hashtags = (b.tags || []).join(" ");
}
fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
console.log("posts.json lokalisiert: " + lang);
' "$POSTS" "$PROJ/scripts/campaign/post-text.cjs" "$DATE"; then
  echo "WARNUNG: posts.json nicht lokalisiert (Caption bleibt in Originalsprache)"
fi

for PL in TikTok Instagram YouTubeShorts; do
  HOOK=$(node -e "const p=require('$POSTS').posts.find(x=>x.platform==='$PL'); console.log(p?String(p.hook||p.title||'').split('\n')[0]:'')")
  [ -z "$HOOK" ] && { echo "kein Hook fuer $PL, uebersprungen"; continue; }
  OUT="$CLIPDIR/$DATE-$PL.mp4"
  echo "Short fuer $PL: $OUT · Hook: $HOOK"
  if [ "$PL" = "Instagram" ]; then
    "$PY" "$PROJ/scripts/short.py" --hook "$HOOK" --lang "$POST_LANG" \
      --out "$OUT" --cover "$CLIPDIR/$DATE-Instagram.jpg" \
      || echo "Short $PL FEHLGESCHLAGEN"
  else
    "$PY" "$PROJ/scripts/short.py" --hook "$HOOK" --lang "$POST_LANG" \
      --out "$OUT" || echo "Short $PL FEHLGESCHLAGEN"
  fi
done

node -e '
const fs=require("fs");
const cfg="/Users/up/.n8n/agent/config.json";
const d=JSON.parse(fs.readFileSync(cfg,"utf8"));
d.instagram=d.instagram||{};
d.instagram.imageUrl="https://pixelmaps.org/clips/generated/"+process.argv[1]+"-Instagram.jpg";
d.instagram.reelVideoUrl="https://pixelmaps.org/clips/generated/"+process.argv[1]+"-Instagram.mp4";
fs.writeFileSync(cfg,JSON.stringify(d,null,2)+"\n");
' "$DATE"

echo "Deploy auf pixelmaps.org ..."
cd "$PROJ" || exit 1
npx wrangler deploy || { echo "FEHLGESCHLAGEN: Deploy"; exit 1; }

echo "Push zu Buffer ..."
# Vorher Slots freiräumen: der Agent pusht 3 Beiträge, free plan erlaubt
# max. 10 scheduled Posts pro Kanal.
node "$PROJ/scripts/fill-queue.cjs" --trim --reserve 3 || true
node "$AGENT" --push "$DATE"

# Queue erst NACH dem Tages-Push auffüllen: free plan erlaubt max. 10
# scheduled Posts pro Kanal, der Agent braucht davon 3 Slots.
echo "Buffer-Queue auffüllen ..."
node "$PROJ/scripts/campaign/topup.mjs" || true
node "$PROJ/scripts/fill-queue.cjs" 2>/dev/null || true

# Kostenloser Orchestrator: internationale Hooks generieren + Lücken füllen
echo "Orchestrator (international) ..."
# Fehler nicht verschlucken: 2>/dev/null hat monatelang verdeckt, dass der
# Lauf auf dem Mac an host.docker.internal scheitert.
node "$HOME/.n8n/agent/orchestrator.js" || echo "Orchestrator fehlgeschlagen"
node "$HOME/.n8n/agent/orchestrator-push.js" || echo "Orchestrator-Push fehlgeschlagen"
echo "=== fertig ==="
