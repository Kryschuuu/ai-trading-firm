#!/usr/bin/env bash
#
# Vollautomatischer Missions-Lauf (Paper-Modus).
#
# Ruft fuer die handelbaren ACTIVE-Missionen die LLM-Pipeline auf
# (`POST /api/firm/run {missionId, pipeline:true}`: CEO → Research → Backtest
# → Devil's Advocate → Risk → Approver → Executor). Der Executor fuehrt ein
# APPROVED-Proposal sofort aus, weil `REQUIRE_HUMAN_APPROVAL` nicht "true" ist.
#
# Es laufen pro Aufruf nur MAX_MISSIONS Missionen; der Cursor in
# `data/auto-pipeline-cursor.json` rotiert weiter, damit die lokale
# LLM-Instanz nicht dauerhaft ausgelastet wird.
#
# Kein Live-Trading: der Live-Gate bleibt unabhaengig davon geschlossen.
#
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

TOKEN=$(grep -m1 '^FIRM_API_TOKEN=' .env | cut -d= -f2-)
BASE=${FIRM_BASE_URL:-http://127.0.0.1:3369}
TIMEOUT=${PIPELINE_TIMEOUT_S:-1200}
MAX=${MAX_MISSIONS:-3}
CURSOR=data/auto-pipeline-cursor.json
mkdir -p data

if [ -z "$TOKEN" ]; then
  echo "[auto-pipeline] FIRM_API_TOKEN fehlt — Lauf uebersprungen."
  exit 0
fi

if ! curl -sf -m 10 "$BASE/api/health" >/dev/null 2>&1; then
  echo "[auto-pipeline] App nicht erreichbar ($BASE) — Lauf uebersprungen."
  exit 0
fi

mapfile -t IDS < <(curl -s -m 20 "$BASE/api/firm/missions" -H "x-firm-token: $TOKEN" | python3 -c '
import json, sys
data = json.load(sys.stdin)
tradeable_symbols = {"BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "LINK", "DOT"}
for m in data.get("missions") or []:
    if m.get("status") != "ACTIVE":
        continue
    if (m.get("symbol") or "") in tradeable_symbols or (m.get("segment") or "") in {"CRYPTO", "ALL", "LIQUID"}:
        print(m["id"])
')

if [ "${#IDS[@]}" -eq 0 ]; then
  echo "[auto-pipeline] Keine handelbaren ACTIVE-Missionen — nichts zu tun."
  exit 0
fi

START=0
if [ -f "$CURSOR" ]; then
  START=$(python3 -c "import json;print(int(json.load(open('$CURSOR')).get('next',0)))" 2>/dev/null || echo 0)
fi

NEXT=$(( (START + MAX) % ${#IDS[@]} ))
printf '{"next":%d,"at":"%s"}\n' "$NEXT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$CURSOR"

for ((i = 0; i < MAX && i < ${#IDS[@]}; i++)); do
  idx=$(( (START + i) % ${#IDS[@]} ))
  id=${IDS[$idx]}
  echo "[auto-pipeline] Mission $id — Pipeline startet ($(date -u +%H:%M:%SZ))"
  out=$(curl -s -m "$TIMEOUT" -X POST "$BASE/api/firm/run" \
    -H "x-firm-token: $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"missionId\":\"$id\",\"pipeline\":true}")
  OUT="$out" python3 - "$id" <<'PY'
import json, os, sys
mid = sys.argv[1]
try:
    d = json.loads(os.environ.get("OUT") or "")
except Exception:
    print(f"[auto-pipeline] {mid}: ungueltige Antwort")
    raise SystemExit(0)
if not d.get("ok"):
    print(f"[auto-pipeline] {mid}: FEHLER {str(d.get('error'))[:160]}")
    raise SystemExit(0)
steps = d.get("pipeline") or []
trades = [s for s in steps if str(s.get("action", "")).upper() == "TRADE"]
print(f"[auto-pipeline] {mid}: {len(steps)} Schritte, {len(trades)} TRADE-Entscheidung(en)")
PY
done

echo "[auto-pipeline] Lauf beendet ($(date -u +%H:%M:%SZ))"
