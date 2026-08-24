#!/usr/bin/env bash
#
# Funktionstest der laufenden Trading-Firma.
# Prüft Dienst, Datenbank, Modellserver, Guardrails und Not-Halt.
#
#   ./scripts/smoke-test.sh
#   BASE_URL=http://192.168.1.42:3000 ./scripts/smoke-test.sh
#
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
# Optional: FIRM_API_TOKEN aus .env lesen, wenn vorhanden
if [[ -z "${FIRM_API_TOKEN:-}" && -f ".env" ]]; then
  FIRM_API_TOKEN="$(grep -E '^FIRM_API_TOKEN=' .env | cut -d= -f2- | tr -d '"' || true)"
fi
AUTH=()
[[ -n "${FIRM_API_TOKEN:-}" ]] && AUTH=(-H "x-firm-token: ${FIRM_API_TOKEN}")
PASS=0; FAIL=0

C_RESET=$'\e[0m'; C_BOLD=$'\e[1m'; C_GREEN=$'\e[32m'
C_RED=$'\e[31m'; C_YELLOW=$'\e[33m'; C_CYAN=$'\e[36m'

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  ${C_GREEN}✓${C_RESET} ${label}"; ((PASS++))
  else
    echo "  ${C_RED}✗${C_RESET} ${label}"; ((FAIL++))
  fi
}

note() { echo "  ${C_YELLOW}·${C_RESET} $*"; }

echo
echo "${C_BOLD}Funktionstest — ${BASE_URL}${C_RESET}"
echo

command -v jq >/dev/null || { echo "${C_RED}jq wird benötigt: sudo pacman -S jq${C_RESET}"; exit 1; }

# ------------------------------------------------------------- 1. Erreichbar
echo "${C_CYAN}1. Dienst${C_RESET}"
check "Healthcheck antwortet" curl -sf --max-time 5 "${BASE_URL}/api/health"

HEALTH="$(curl -s --max-time 5 "${BASE_URL}/api/health" 2>/dev/null)"
# KORRIGIERT (v1.1.0): Die Health-API liefert 'schemaReady' (bool), nicht
# 'status' — der alte Abgleich auf SCHEMA_MISSING war toter Code.
SCHEMA_READY="$(jq -r '.schemaReady // "UNKNOWN"' <<<"${HEALTH:-{}}" 2>/dev/null)"

if [[ "$SCHEMA_READY" == "false" ]]; then
  echo
  echo "${C_RED}╔══════════════════════════════════════════════════════════╗${C_RESET}"
  echo "${C_RED}║  SETUP ERFORDERLICH: Datenbanktabellen fehlen            ║${C_RESET}"
  echo "${C_RED}╚══════════════════════════════════════════════════════════╝${C_RESET}"
  echo
  echo "  Fehlende Tabellen:"
  jq -r '.missingTables[]? | "    - \(.)"' <<<"$HEALTH"
  echo
  echo "  Lösung (im Projektstamm ausführen):"
  echo
  echo "    ${C_BOLD}npx drizzle-kit push${C_RESET}"
  echo
  echo "  Dann den Dienst neu starten und diesen Test erneut ausführen."
  echo
  echo "  Häufige Ursache bei Variante B: .env noch nicht angelegt oder"
  echo "  DATABASE_URL zeigt auf die falsche Datenbank."
  exit 1
fi

check "Firmenzustand abrufbar" curl -sf --max-time 10 "${BASE_URL}/api/firm"

STATE="$(curl -s --max-time 10 "${BASE_URL}/api/firm" 2>/dev/null)"
if [[ -z "$STATE" ]]; then
  echo
  echo "${C_RED}Der Dienst antwortet nicht. Läuft 'npm run start'?${C_RESET}"
  exit 1
fi

# ------------------------------------------------------------------ 2. Seed
echo
echo "${C_CYAN}2. Stammdaten${C_RESET}"
curl -sf -X POST "${BASE_URL}/api/seed" "${AUTH[@]}" >/dev/null 2>&1
STATE="$(curl -s "${BASE_URL}/api/firm")"

AGENTS="$(jq '.agents | length'   <<<"$STATE")"
MISSIONS="$(jq '.missions | length' <<<"$STATE")"
check "Sechs Agenten angelegt (gefunden: ${AGENTS})" test "$AGENTS" -ge 6
check "Mindestens eine Mission (gefunden: ${MISSIONS})" test "$MISSIONS" -ge 1

jq -r '.agents[] | "      \(.role): \(.model)"' <<<"$STATE"

# ------------------------------------------------------------------- 3. LLM
echo
echo "${C_CYAN}3. Modellserver${C_RESET}"
LLM_OK="$(jq -r '.ollama.available' <<<"$STATE")"
LLM_URL="$(jq -r '.ollama.baseUrl'  <<<"$STATE")"
LLM_PROV="$(jq -r '.ollama.provider' <<<"$STATE")"
LLM_N="$(jq -r '.ollama.models | length' <<<"$STATE")"

if [[ "$LLM_OK" == "true" ]]; then
  echo "  ${C_GREEN}✓${C_RESET} ${LLM_PROV} erreichbar (${LLM_URL}), ${LLM_N} Modelle"; ((PASS++))
else
  echo "  ${C_YELLOW}!${C_RESET} Kein Modellserver auf ${LLM_URL} — Regel-Engine aktiv"
  note "Kein Fehler, aber die Pipeline testet dann nur die Orchestrierung."
fi

# ------------------------------------------------------------ 4. Guardrails
echo
echo "${C_CYAN}4. Harte Grenzen${C_RESET}"
check "maxPositionPct gesetzt"   test "$(jq -r '.riskLimits.maxPositionPct' <<<"$STATE")" != "null"
check "Shorts gesperrt"          test "$(jq -r '.riskLimits.allowShort'     <<<"$STATE")" == "false"
check "Kein Hebel"               test "$(jq -r '.riskLimits.maxLeverage'    <<<"$STATE")" == "1"
check "Stop-Loss verpflichtend"  test "$(jq -r '.riskLimits.requireStopLoss' <<<"$STATE")" == "true"

jq -r '"      Position max \(.riskLimits.maxPositionPct*100)% · Risiko/Trade \(.riskLimits.maxRiskPerTrade*100)% · Auto-Kill bei \(.riskLimits.maxEquityDrawdownPct*100)% Drawdown"' <<<"$STATE"

# -------------------------------------------------------------- 5. Pipeline
echo
echo "${C_CYAN}5. Pipeline-Durchlauf${C_RESET}"
MISSION="$(jq -r '.missions[0].id' <<<"$STATE")"

if [[ "$(jq -r '.killSwitchArmed' <<<"$STATE")" == "true" ]]; then
  note "Not-Halt ist aktiv — wird für den Test entschärft."
  curl -s -X POST "${BASE_URL}/api/firm/kill" "${AUTH[@]}" \
    -H 'Content-Type: application/json' -d '{"arm":false}' >/dev/null
fi

note "Läuft… (Variante A kann einige Minuten dauern)"
START=$(date +%s)
RESULT="$(curl -s --max-time 900 -X POST "${BASE_URL}/api/firm/run" "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -d "{\"missionId\":\"${MISSION}\",\"pipeline\":true}")"
ELAPSED=$(( $(date +%s) - START ))

if [[ "$(jq -r '.ok' <<<"$RESULT")" == "true" ]]; then
  echo "  ${C_GREEN}✓${C_RESET} Pipeline durchgelaufen (${ELAPSED}s)"; ((PASS++))
  jq -r '.pipeline[] | "      \(.role): \(.result.status)  [\(.result.source), \(.result.latencyMs)ms]"' <<<"$RESULT"
else
  echo "  ${C_RED}✗${C_RESET} Pipeline fehlgeschlagen: $(jq -r '.error' <<<"$RESULT")"; ((FAIL++))
fi

# -------------------------------------------------------------- 6. Not-Halt
echo
echo "${C_CYAN}6. Not-Halt${C_RESET}"
KILL="$(curl -s -X POST "${BASE_URL}/api/firm/kill" "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"arm":true,"flatten":true,"reason":"smoke-test"}')"
check "Kill-Switch lässt sich ziehen" test "$(jq -r '.killSwitchArmed' <<<"$KILL")" == "true"
note "Dabei glattgestellt: $(jq -r '.closedPositions' <<<"$KILL") Position(en)"

BLOCKED="$(curl -s --max-time 300 -X POST "${BASE_URL}/api/firm/run" "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -d "{\"missionId\":\"${MISSION}\",\"pipeline\":true}")"
if jq -e '.pipeline[]?.result.status | select(. == "EXECUTED")' <<<"$BLOCKED" >/dev/null 2>&1; then
  echo "  ${C_RED}✗${C_RESET} SCHWERWIEGEND: Order trotz aktivem Not-Halt ausgeführt!"; ((FAIL++))
else
  echo "  ${C_GREEN}✓${C_RESET} Orders werden bei aktivem Not-Halt blockiert"; ((PASS++))
fi

curl -s -X POST "${BASE_URL}/api/firm/kill" "${AUTH[@]}" \
  -H 'Content-Type: application/json' -d '{"arm":false}' >/dev/null
note "Not-Halt wieder entschärft."


# ------------------------------------------- 7. Reports, Kurve, Sicherheit
echo
echo "${C_CYAN}7. Reports, Equity-Kurve & Sicherheit${C_RESET}"

check "Report-API (Tag)"     curl -sf --max-time 15 "${BASE_URL}/api/firm/report?period=day"
check "Report-API (Woche)"   curl -sf --max-time 15 "${BASE_URL}/api/firm/report?period=week"
check "Equity-Kurve (Tag)"   curl -sf --max-time 15 "${BASE_URL}/api/firm/equity?range=day"
check "Protokoll-API"        curl -sf --max-time 15 "${BASE_URL}/api/firm/log?limit=5"

SNAP_N="$(curl -s "${BASE_URL}/api/firm/equity?range=all" | jq '.series | length')"
check "Snapshots vorhanden (${SNAP_N})" test "${SNAP_N}" -ge 1

# Konfigurations-Klemmung: 0.9 muss auf das Code-Maximum 0.5 geklemmt werden
CLAMP="$(curl -s -X PUT "${BASE_URL}/api/firm/config" "${AUTH[@]}" \
  -H 'Content-Type: application/json' -d '{"key":"maxPositionPct","value":0.9}')"
if [[ "$(jq -r '.effective' <<<"$CLAMP")" == "0.5" ]]; then
  echo "  ${C_GREEN}✓${C_RESET} Ceiling-Klemmung aktiv (0.9 → 0.5)"; ((PASS++))
else
  echo "  ${C_RED}✗${C_RESET} Ceiling-Klemmung FEHLERHAFT: $(jq -c . <<<"$CLAMP")"; ((FAIL++))
fi
# Wert zurücksetzen
curl -s -X PUT "${BASE_URL}/api/firm/config" "${AUTH[@]}" \
  -H 'Content-Type: application/json' -d '{"key":"maxPositionPct","value":0.25}' >/dev/null

# Token-Schutz prüfen (nur wenn konfiguriert)
if [[ -n "${FIRM_API_TOKEN:-}" ]]; then
  CODE_NO_AUTH="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/api/firm/tick")"
  if [[ "$CODE_NO_AUTH" == "401" ]]; then
    echo "  ${C_GREEN}✓${C_RESET} POST ohne Token wird abgewiesen (401)"; ((PASS++))
  else
    echo "  ${C_RED}✗${C_RESET} SCHWERWIEGEND: POST ohne Token ergab ${CODE_NO_AUTH}, erwartet 401!"; ((FAIL++))
  fi
else
  note "Kein FIRM_API_TOKEN gesetzt — offener Lokalbetrieb (Server lauscht auf 127.0.0.1)."
fi

# Analysten im Team?
ANALYSTS="$(jq '[.agents[] | select(.role == "TECHNICAL_ANALYST" or .role == "MACRO_ANALYST" or .role == "NEWS_ANALYST" or .role == "SWING_RESEARCHER" or .role == "SCOUT" or .role == "DILIGENCE")] | length' <<<"$STATE")"
check "Analysten-Team angelegt (gefunden: ${ANALYSTS}/6)" test "$ANALYSTS" -ge 6

# ------------------------------------------------------------------ Ergebnis
echo
echo "${C_BOLD}Ergebnis: ${C_GREEN}${PASS} bestanden${C_RESET}, ${C_RED}${FAIL} fehlgeschlagen${C_RESET}"
echo
if (( FAIL == 0 )); then
  echo "${C_GREEN}Alles in Ordnung. Weiter im Handbuch, Kapitel 3.${C_RESET}"
else
  echo "${C_YELLOW}Fehler prüfen: docs/INSTALL.md Kapitel 11 (Typische Fehler).${C_RESET}"
fi
echo
exit $(( FAIL > 0 ? 1 : 0 ))
