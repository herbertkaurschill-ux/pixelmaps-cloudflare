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

# 7-Sprachen-Rotation (Weltrekord-Versuch), eine Sprache pro Tag
LANG=$("$PY" -c "import datetime;print(['de','en','es','fr','it','pt','tr'][(datetime.date.fromisoformat('$DATE')-datetime.date(2026,9,22)).days%7])")
# Design-Rotation: neon/pop im Wechsel
IDX=$("$PY" -c "import datetime;print((datetime.date.fromisoformat('$DATE')-datetime.date(2026,9,22)).days)")
VARIANT=neon; [ $((IDX % 2)) -eq 1 ] && VARIANT=pop
echo "Sprache/Tag: $LANG · Design: $VARIANT"

mkdir -p "$CLIPDIR"
exec >>"$LOG" 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') publish-day $DATE ==="

if [ ! -f "$POSTS" ]; then
  echo "posts.json fehlt -> generiere (review-only) im n8n-Container ..."
  docker exec n8n node /home/node/.n8n/agent/agent.js || { echo "FEHLGESCHLAGEN: Generierung"; exit 1; }
fi
[ -f "$POSTS" ] || { echo "FEHLGESCHLAGEN: kein posts.json"; exit 1; }

for PL in TikTok YouTubeShorts; do
  HOOK=$(node -e "const p=require('$POSTS').posts.find(x=>x.platform==='$PL'); console.log(p?(p.hook||p.title||''):'')")
  TITLE=$(node -e "const p=require('$POSTS').posts.find(x=>x.platform==='$PL'); console.log(p?(p.title||p.hook||''):'')")
  [ -z "$HOOK" ] && { echo "kein Hook fuer $PL, uebersprungen"; continue; }
  OUT="$CLIPDIR/$DATE-$PL.mp4"
  echo "Clip fuer $PL: $OUT"
  "$PY" "$PROJ/scripts/clipmap.py" \
    --prompt "$HOOK" \
    --title "$TITLE" \
    --subtitle "" \
    --lang "$LANG" \
    --variant "$VARIANT" \
    --out "$OUT" \
    --duration 6 || echo "Clip $PL FEHLGESCHLAGEN"
done

IG_PIC="$CLIPDIR/$DATE-Instagram.jpg"
echo "Poster fuer Instagram: $IG_PIC"
"$PY" "$PROJ/scripts/clipmap.py" --prompt "" --title "" --subtitle "" \
  --out "$IG_PIC" --poster || echo "Poster FEHLGESCHLAGEN"

IG_REEL="$CLIPDIR/$DATE-InstagramReel.mp4"
echo "Reel fuer Instagram: $IG_REEL"
TG_HOOK=$(node -e "const p=require('$POSTS').posts.find(x=>x.platform==='TikTok'); console.log(p?(p.hook||p.title||''):'')")
"$PY" "$PROJ/scripts/clipmap.py" --prompt "$TG_HOOK" --title "$TG_HOOK" --subtitle "" \
  --lang "$LANG" --variant "$VARIANT" --out "$IG_REEL" --duration 6 || echo "Reel FEHLGESCHLAGEN"

node -e '
const fs=require("fs");
const cfg="/Users/up/.n8n/agent/config.json";
const d=JSON.parse(fs.readFileSync(cfg,"utf8"));
d.instagram=d.instagram||{};
d.instagram.imageUrl="https://pixelmaps.org/clips/generated/"+process.argv[1]+"-Instagram.jpg";
d.instagram.reelVideoUrl="https://pixelmaps.org/clips/generated/"+process.argv[1]+"-InstagramReel.mp4";
fs.writeFileSync(cfg,JSON.stringify(d,null,2)+"\n");
' "$DATE"

echo "Deploy auf pixelmaps.org ..."
cd "$PROJ" || exit 1
npx wrangler deploy || { echo "FEHLGESCHLAGEN: Deploy"; exit 1; }

echo "Push zu Buffer ..."
# Vorher Slots freiräumen: der Agent pusht 3 Beiträge, free plan erlaubt
# max. 10 scheduled Posts pro Kanal.
node "$PROJ/scripts/fill-queue.cjs" --trim || true
node "$AGENT" --push "$DATE"

# Queue erst NACH dem Tages-Push auffüllen: free plan erlaubt max. 10
# scheduled Posts pro Kanal, der Agent braucht davon 3 Slots.
echo "Buffer-Queue auffüllen ..."
node "$PROJ/scripts/campaign/topup.mjs" || true
node "$PROJ/scripts/fill-queue.cjs" 2>/dev/null || true

# Kostenloser Orchestrator: internationale Hooks generieren + Lücken füllen
echo "Orchestrator (international) ..."
node "$HOME/.n8n/agent/orchestrator.js" 2>/dev/null || true
node "$HOME/.n8n/agent/orchestrator-push.js" 2>/dev/null || true
echo "=== fertig ==="
