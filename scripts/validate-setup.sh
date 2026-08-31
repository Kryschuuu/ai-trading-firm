#!/usr/bin/env bash
#
# Validierungs-Routine der autonomen KI-Trading-Firma (v1.30.0).
#
#   ./scripts/validate-setup.sh
#   BASE_URL=http://192.168.1.42:3369 ./scripts/validate-setup.sh
#   ./scripts/validate-setup.sh --min-pass 15 --json
#
# ── Warum ein eigenes Skript neben scripts/smoke-test.sh? ──────────────────
# `smoke-test.sh` ist ein FUNKTIONSTEST: er fährt eine komplette Pipeline
# (bis zu 900 s) und zieht am Ende den Not-Halt. Dieses Skript ist ein
# SETUP-VALIDATOR: 18 schnelle, deterministische Checks ohne Pipeline-Lauf und
# ohne Zustandsänderung (einzige Ausnahme: Check V17 setzt `maxPositionPct`
# kurz und stellt den Wert danach zurück).
#
# Es ist die Abnahme-Routine von `scripts/setup-cachyos.sh` und kann jederzeit
# einzeln gegen eine laufende Instanz gefahren werden.
#
# ── Die 18 Checks ──────────────────────────────────────────────────────────
#   V01 Healthcheck antwortet
#   V02 Datenbankschema bereit (schemaReady)
#   V03 Version entspricht package.json
#   V04 Firmenzustand abrufbar
#   V05 Agenten-Team vollständig (12 Rollen)
#   V06 Mindestens eine Mission vorhanden
#   V07 Mission-ID ist eine gültige UUID          ← Fix „invalid input syntax
#                                                    for type uuid" / „null"
#   V08 Aktien-Universum ≥ 50
#   V09 Indizes-Universum ≥ 50
#   V10 Rohstoff-Universum ≥ 20
#   V11 Krypto-Universum ≥ 30
#   V12 Broker-Adapter = PAPER                    ← Fix UNEXPECTED_BROKER_ADAPTER
#   V13 Kein Hebel (maxLeverage = 1)
#   V14 Stop-Loss verpflichtend
#   V15 Positionsgröße innerhalb des Code-Ceilings
#   V16 Short-Selling im konfigurierten Soll-Zustand (Default: aktiviert)
#   V17 Ceiling-Klemmung 90 % → 0.5               ← Fix: Prozent, nicht Bruch
#   V18 API-Token-Schutz (401 ohne x-firm-token)
#
# ── Bewertung ──────────────────────────────────────────────────────────────
# Bestanden gilt ab `--min-pass` (Default 15) von 18. Einzelne Checks dürfen
# aus dokumentierten Gründen fehlschlagen:
#   * V18, wenn der Betrieb bewusst ohne FIRM_API_TOKEN gewählt wurde
#     (`--no-api-token` bzw. offener Lokalbetrieb auf 127.0.0.1).
#   * V08–V11, wenn das Preset-Universum noch nicht geseedet wurde
#     (`npm run universe:seed:markets`).
#   * V16, wenn Short-Selling bewusst abgeschaltet wurde (`--no-shorts`).
# Jeder Fehlcheck gibt deshalb immer die konkrete Behebungszeile aus.
#
# Exit-Codes: 0 = bestanden · 1 = nicht bestanden · 2 = Bedien-/Umgebungsfehler
#
set -uo pipefail

# ── Konfiguration (Env hat Vorrang vor Default, CLI hat Vorrang vor Env) ────
BASE_URL="${BASE_URL:-http://127.0.0.1:3369}"
MIN_PASS="${MIN_PASS:-15}"
EXPECT_SHORTS="${EXPECT_SHORTS:-true}"
OUTPUT_JSON="false"
TIMEOUT_SECONDS="${VALIDATE_TIMEOUT_SECONDS:-15}"

# ── Farben (nur bei TTY, damit Logs/CI sauber bleiben) ──────────────────────
if [[ -t 1 ]]; then
  C_RESET=$'\e[0m'; C_BOLD=$'\e[1m'; C_GREEN=$'\e[32m'
  C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_CYAN=$'\e[36m'; C_DIM=$'\e[2m'
else
  C_RESET=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_DIM=""
fi

PASS=0
FAIL=0
# Ergebnisse für --json: "ID|status|label|detail"
RESULTS=()
# IDs der fehlgeschlagenen Checks
FAILED_IDS=()

usage() {
  cat <<'EOF'
Verwendung:
  ./scripts/validate-setup.sh [Optionen]

Optionen:
  --base-url URL      Basis-URL der laufenden Instanz
                      (Default: $BASE_URL bzw. http://127.0.0.1:3369)
  --min-pass N        Mindestanzahl bestandener Checks von 18 (Default: 15)
  --expect-shorts B   Soll-Zustand Short-Selling: true|false (Default: true)
  --timeout SEK       HTTP-Timeout je Check (Default: 15)
  --json              Ergebnis als JSON auf stdout
  -h, --help          diese Hilfe

Umgebungsvariablen:
  BASE_URL            wie --base-url
  MIN_PASS            wie --min-pass
  EXPECT_SHORTS       wie --expect-shorts
  FIRM_API_TOKEN      API-Token; wird sonst aus ./.env gelesen
  VALIDATE_TIMEOUT_SECONDS  wie --timeout

Exit-Codes: 0 bestanden · 1 nicht bestanden · 2 Bedien-/Umgebungsfehler
EOF
}

die() {
  printf '%s\n' "${C_RED}✗ $*${C_RESET}" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)      [[ $# -ge 2 ]] || die "--base-url braucht einen Wert"; BASE_URL="$2"; shift 2 ;;
    --min-pass)      [[ $# -ge 2 ]] || die "--min-pass braucht einen Wert"; MIN_PASS="$2"; shift 2 ;;
    --expect-shorts) [[ $# -ge 2 ]] || die "--expect-shorts braucht einen Wert"; EXPECT_SHORTS="$2"; shift 2 ;;
    --timeout)       [[ $# -ge 2 ]] || die "--timeout braucht einen Wert"; TIMEOUT_SECONDS="$2"; shift 2 ;;
    --json)          OUTPUT_JSON="true"; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               usage >&2; die "Unbekannte Option: $1" ;;
  esac
done

# ── Eingaben hart validieren: die Werte landen in URLs/JSON/Arithmetik ──────
[[ "$MIN_PASS" =~ ^[0-9]+$ ]] || die "--min-pass muss eine Ganzzahl sein (war: '$MIN_PASS')"
(( MIN_PASS >= 1 && MIN_PASS <= 18 )) || die "--min-pass muss zwischen 1 und 18 liegen (war: $MIN_PASS)"
[[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ && "$TIMEOUT_SECONDS" -ge 1 ]] || die "--timeout muss eine Ganzzahl ≥ 1 sein"
case "${EXPECT_SHORTS,,}" in
  true|false) EXPECT_SHORTS="${EXPECT_SHORTS,,}" ;;
  *) die "--expect-shorts erwartet true oder false (war: '$EXPECT_SHORTS')" ;;
esac
# URL-Whitelist: Schema + Host + optional Port/Pfad. Verhindert Header-Injection
# über mitgeschleppte Steuerzeichen.
[[ "$BASE_URL" =~ ^https?://[A-Za-z0-9._-]+(:[0-9]{1,5})?(/[A-Za-z0-9._/-]*)?$ ]] \
  || die "Ungültige --base-url: '$BASE_URL'"
BASE_URL="${BASE_URL%/}"

# ── FIRM_API_TOKEN: Env gewinnt, sonst ./.env ───────────────────────────────
if [[ -z "${FIRM_API_TOKEN:-}" && -f ".env" ]]; then
  # Nur die letzte Zuweisung zaehlt (dotenv-Semantik); umschliessende Quotes
  # und CR (Windows-Zeilenenden) entfernen.
  FIRM_API_TOKEN="$(sed -n 's/^FIRM_API_TOKEN=//p' .env | tail -1)"
  FIRM_API_TOKEN="${FIRM_API_TOKEN%$'\r'}"
  FIRM_API_TOKEN="${FIRM_API_TOKEN#\"}"; FIRM_API_TOKEN="${FIRM_API_TOKEN%\"}"
  FIRM_API_TOKEN="${FIRM_API_TOKEN#\'}"; FIRM_API_TOKEN="${FIRM_API_TOKEN%\'}"
fi
AUTH_HEADERS=()
if [[ -n "${FIRM_API_TOKEN:-}" ]]; then
  AUTH_HEADERS=(-H "x-firm-token: ${FIRM_API_TOKEN}")
fi

# ── Werkzeug-Prüfung (fail fast, bevor Checks fehlerhaft zählen) ────────────
for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' fehlt — installieren: sudo pacman -S $tool"
done

# ── HTTP-Helfer ─────────────────────────────────────────────────────────────

# GET → Body auf stdout; leer + Status 000 bei Verbindungsfehler.
http_get() {
  curl -s --max-time "$TIMEOUT_SECONDS" "$1" 2>/dev/null || true
}

# GET mit Erwartung auf HTTP 200.
http_get_ok() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT_SECONDS" "$1" 2>/dev/null || echo 000)"
  [[ "$code" == "200" ]]
}

# POST/PUT mit JSON-Body und optionaler Auth; Body auf stdout.
http_json() {
  local method="$1" url="$2" body="$3"
  curl -s --max-time "$TIMEOUT_SECONDS" -X "$method" "$url" \
    -H 'Content-Type: application/json' \
    ${AUTH_HEADERS[@]+"${AUTH_HEADERS[@]}"} \
    -d "$body" 2>/dev/null || true
}

# jq-Zugriff, der bei kaputtem JSON nie "null" als gültigen Wert durchreicht.
jqr() {
  local filter="$1" json="${2:-}"
  [[ -n "$json" ]] || { printf 'null'; return 0; }
  jq -r "$filter" <<<"$json" 2>/dev/null || printf 'null'
}

# ── Check-Registrierung ─────────────────────────────────────────────────────
# check <ID> <Label> <Behebung> <Kommando…>
# Fortschrittsausgabe: stdout im Normalmodus, stderr im JSON-Modus
# (stdout muss dort reines JSON bleiben).
progress() {
  if [[ "$OUTPUT_JSON" == "true" ]]; then printf '%s\n' "$*" >&2
  else printf '%s\n' "$*"; fi
}

check() {
  local id="$1" label="$2" fix="$3"; shift 3
  if "$@" >/dev/null 2>&1; then
    progress "$(printf '  %s✓%s [%s] %s' "$C_GREEN" "$C_RESET" "$id" "$label")"
    PASS=$((PASS + 1))
    RESULTS+=("${id}|pass|${label}|")
  else
    progress "$(printf '  %s✗%s [%s] %s' "$C_RED" "$C_RESET" "$id" "$label")"
    progress "$(printf '      %sBehebung:%s %s' "$C_DIM" "$C_RESET" "$fix")"
    FAIL=$((FAIL + 1))
    FAILED_IDS+=("$id")
    RESULTS+=("${id}|fail|${label}|${fix}")
  fi
}

section() {
  printf '\n%s%s%s\n' "$C_CYAN" "$1" "$C_RESET" >&2
}

# UUID-v4-Form (8-4-4-4-12 Hex). Genügt, um „null"/leer/Trümmer abzufangen —
# die DB akzeptiert jede gültige UUID, der Fehler kam nie von der Version.
looks_like_uuid() {
  [[ "${1:-}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]
}

progress "$(printf '\n%sValidierung — %s%s' "$C_BOLD" "$BASE_URL" "$C_RESET")"
progress "$(printf '  Soll: %s/18 Checks · Short-Selling erwartet: %s · Token: %s' \
  "$MIN_PASS" "$EXPECT_SHORTS" "$( [[ -n "${FIRM_API_TOKEN:-}" ]] && echo gesetzt || echo 'nicht gesetzt' )")"

# ── Zustandsdaten einmalig laden (ein Roundtrip statt 18) ───────────────────
HEALTH="$(http_get "${BASE_URL}/api/health")"
STATE="$(http_get "${BASE_URL}/api/firm")"
BROKERS="$(http_get "${BASE_URL}/api/brokers")"
LIVE="$(http_get "${BASE_URL}/api/live/state")"

# ─────────────────────────────────────────────────────────────────────────────
section "1. Dienst & Schema"
# ─────────────────────────────────────────────────────────────────────────────

check "V01" "Healthcheck antwortet (GET /api/health)" \
  "Läuft der Dienst? npm run start — dann erneut validieren." \
  http_get_ok "${BASE_URL}/api/health"

SCHEMA_READY="$(jqr '.schemaReady // "UNKNOWN"' "$HEALTH")"
check "V02" "Datenbankschema bereit (schemaReady=true)" \
  "npx drizzle-kit push — danach Dienst neu starten. Fehlende Tabellen: $(jqr '.missingTables | join(", ")' "$HEALTH")" \
  test "$SCHEMA_READY" = "true"

# `test` akzeptiert maximal einen Vergleich — für Verbundbedingungen deshalb
# eine eigene, lesbare Prüffunktion.
version_matches() {
  [[ -n "${PKG_VERSION:-}" && "${APP_VERSION:-}" == "${PKG_VERSION}" ]]
}
PKG_VERSION="$(jq -r '.version // empty' package.json 2>/dev/null || true)"
APP_VERSION="$(jqr '.version // "UNKNOWN"' "$HEALTH")"
check "V03" "Version konsistent (package.json ${PKG_VERSION:-?} = API ${APP_VERSION})" \
  "npm run build neu ausführen — der laufende Prozess ist älter als der Quellstand." \
  version_matches

check "V04" "Firmenzustand abrufbar (GET /api/firm)" \
  "PostgreSQL erreichbar? DATABASE_URL in .env korrekt? Logs: journalctl -u ai-trading-firm -n 50" \
  http_get_ok "${BASE_URL}/api/firm"

# ─────────────────────────────────────────────────────────────────────────────
section "2. Stammdaten (Seed)"
# ─────────────────────────────────────────────────────────────────────────────

AGENTS="$(jqr '.agents | length' "$STATE")"
check "V05" "Agenten-Team vollständig (gefunden: ${AGENTS}, erwartet ≥ 12)" \
  "curl -X POST ${BASE_URL}/api/seed -H 'x-firm-token: …' — Seed ist idempotent." \
  test "${AGENTS:-0}" -ge 12

MISSIONS="$(jqr '.missions | length' "$STATE")"
check "V06" "Mindestens eine Mission (gefunden: ${MISSIONS})" \
  "curl -X POST ${BASE_URL}/api/seed -H 'x-firm-token: …' legt die Standard-Mandate an." \
  test "${MISSIONS:-0}" -ge 1

# BUGFIX (v1.30.0): Früher las der Smoke-Test blind `.missions[0].id` und POSTete
# bei leerer Missionsliste den String "null" → PostgreSQL quittierte mit
# „invalid input syntax for type uuid: \"null\"". Hier wird die ID VOR jeder
# Weiterverwendung auf UUID-Form geprüft.
MISSION_ID="$(jqr '.missions[0].id // empty' "$STATE")"
check "V07" "Mission-ID ist eine gültige UUID (${MISSION_ID:-<leer>})" \
  "Missionsliste ist leer oder beschädigt → POST /api/seed; Bestand prüfen: psql \"\$DATABASE_URL\" -c 'SELECT id,title FROM missions;'" \
  looks_like_uuid "$MISSION_ID"

# ─────────────────────────────────────────────────────────────────────────────
section "3. Markt-Universum (Presets)"
# ─────────────────────────────────────────────────────────────────────────────
# `total` ist die Gesamtzahl über alle Seiten — pageSize=1 hält die Antwort klein.
universe_total() {
  local query="$1"
  jqr '.total // 0' "$(http_get "${BASE_URL}/api/markets?${query}&pageSize=1")"
}

N_EQUITY="$(universe_total "assetClass=equity")"
check "V08" "Aktien im Universum (gefunden: ${N_EQUITY}, erwartet ≥ 50)" \
  "npm run universe:seed:markets" \
  test "${N_EQUITY:-0}" -ge 50

N_INDEX="$(universe_total "assetClass=index")"
check "V09" "Indizes im Universum (gefunden: ${N_INDEX}, erwartet ≥ 50)" \
  "npm run universe:seed:markets" \
  test "${N_INDEX:-0}" -ge 50

N_COMMODITY="$(universe_total "assetClass=commodity")"
check "V10" "Rohstoffe im Universum (gefunden: ${N_COMMODITY}, erwartet ≥ 20)" \
  "npm run universe:seed:markets" \
  test "${N_COMMODITY:-0}" -ge 20

N_CRYPTO="$(universe_total "assetClass=crypto")"
check "V11" "Kryptowährungen im Universum (gefunden: ${N_CRYPTO}, erwartet ≥ 30)" \
  "npm run universe:seed:markets" \
  test "${N_CRYPTO:-0}" -ge 30

# ─────────────────────────────────────────────────────────────────────────────
section "4. Broker-Adapter & harte Grenzen"
# ─────────────────────────────────────────────────────────────────────────────

# BUGFIX (v1.30.0): `getBroker()` in src/lib/engine.ts wirft
# UNEXPECTED_BROKER_ADAPTER, wenn die Factory für "PAPER" keinen
# PaperBrokerAdapter liefert. Der Check liest genau das Feld, das dieser Pfad
# befüllt (`/api/firm` → account.broker) und meldet den Werdegang im Fehlerfall.
ACTIVE_BROKER="$(jqr '.account.broker // "UNKNOWN"' "$STATE")"
check "V12" "Broker-Adapter aktiv: PAPER (gefunden: ${ACTIVE_BROKER})" \
  "GET /api/firm liefert 503, wenn die Engine den Adapter nicht erzeugen kann — Logs prüfen (UNEXPECTED_BROKER_ADAPTER). Papier-Modus ist Produktstandard; PAPER_MODE in .env prüfen." \
  test "$ACTIVE_BROKER" = "PAPER"

MAX_LEVERAGE="$(jqr '.riskLimits.maxLeverage // "null"' "$STATE")"
check "V13" "Kein Hebel (maxLeverage = 1, gefunden: ${MAX_LEVERAGE})" \
  "PUT /api/firm/config {\"key\":\"maxLeverage\",\"value\":1} — Code-Ceiling bleibt 3." \
  test "$MAX_LEVERAGE" = "1"

REQUIRE_SL="$(jqr '.riskLimits.requireStopLoss // "null"' "$STATE")"
check "V14" "Stop-Loss verpflichtend (requireStopLoss = true)" \
  "Nicht abschaltbar (LIMIT_CEILINGS.requireStopLoss = [1,1]) — Build/Deployment prüfen." \
  test "$REQUIRE_SL" = "true"

MAX_POS="$(jqr '.riskLimits.maxPositionPct // "null"' "$STATE")"
# Vergleich über awk (bash kennt keine Gleitkomma-Vergleiche). Ein fehlender
# oder nicht-numerischer Wert scheitert bereits an der Regex-Prüfung.
max_position_within_ceiling() {
  [[ "${MAX_POS:-}" =~ ^[0-9]+(\.[0-9]+)?$ ]] || return 1
  awk -v v="$MAX_POS" 'BEGIN { exit !(v > 0 && v <= 0.5) }'
}
check "V15" "Positionsgröße im Code-Fenster (maxPositionPct = ${MAX_POS}, ≤ 0.5)" \
  "PUT /api/firm/config {\"key\":\"maxPositionPct\",\"value\":25} (Eingabe in Prozent)." \
  max_position_within_ceiling

# BUGFIX/FEATURE (v1.30.0): Short-Selling ist per Setup-Default AKTIVIERT.
# Der Check prüft gegen den Soll-Zustand (--expect-shorts), nicht gegen einen
# hartcodierten Wert — sonst wäre ein bewusstes --no-shorts ein Fehler.
ALLOW_SHORT="$(jqr '.riskLimits.allowShort // "null"' "$STATE")"
check "V16" "Short-Selling im Soll-Zustand (ist: ${ALLOW_SHORT}, soll: ${EXPECT_SHORTS})" \
  "PUT /api/firm/config {\"key\":\"allowShort\",\"value\":1} bzw. 0 — oder setup-cachyos.sh mit/ohne --no-shorts erneut ausführen." \
  test "$ALLOW_SHORT" = "$EXPECT_SHORTS"

# ─────────────────────────────────────────────────────────────────────────────
section "5. API-Sicherheit"
# ─────────────────────────────────────────────────────────────────────────────

# BUGFIX (v1.30.0): Seit v1.7.0 normalisiert setConfigValue() Prozent-Units
# (Eingabe 90 = 90 %). Der alte Smoke-Test sendete den BRUCH 0.9 → 0.9/100 =
# 0.009 → Klemmung auf das Minimum 0.01, nie auf das Ceiling 0.5. Der Check
# sendet deshalb 90 und erwartet 0.5.
clamp_ceiling() {
  local before response effective
  before="$(jqr '.riskLimits.maxPositionPct // empty' "$STATE")"
  response="$(http_json PUT "${BASE_URL}/api/firm/config" '{"key":"maxPositionPct","value":90}')"
  effective="$(jqr '.effective // "null"' "$response")"
  # Ursprungswert zurückstellen, damit die Validierung keine Konfiguration
  # dauerhaft verbiegt (best effort; ohne Token schlägt das Schreiben ohnehin
  # fehl und der Wert wurde nie geändert).
  if [[ -n "$before" ]]; then
    local pct
    pct="$(awk "BEGIN{printf \"%.4f\", ${before}*100}" 2>/dev/null || echo 25)"
    http_json PUT "${BASE_URL}/api/firm/config" "{\"key\":\"maxPositionPct\",\"value\":${pct}}" >/dev/null
  fi
  [[ "$effective" == "0.5" ]]
}
check "V17" "Ceiling-Klemmung aktiv (90 % → 0.5)" \
  "PUT /api/firm/config erwartet PROZENT (90 = 90 %), nicht Bruch. Wirkt nur mit gültigem x-firm-token; LIMIT_CEILINGS.maxPositionPct = [0.01, 0.5]." \
  clamp_ceiling

# Ohne konfiguriertes Token ist der Endpunkt bewusst offen (Single-User-
# Lokalbetrieb). Dann ist der Check nicht „kaputt", sondern nicht anwendbar —
# er zählt als Fehlcheck und wird in der Auswertung als dokumentiert markiert.
token_guard() {
  [[ -n "${FIRM_API_TOKEN:-}" ]] || return 1
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT_SECONDS" \
    -X POST "${BASE_URL}/api/firm/tick" 2>/dev/null || echo 000)"
  [[ "$code" == "401" ]]
}
check "V18" "POST ohne Token wird abgewiesen (401)" \
  "FIRM_API_TOKEN ist nicht gesetzt (offener Lokalbetrieb) oder die Route prüft kein Token. Token erzeugen: openssl rand -hex 32 → .env, dann Dienst neu starten." \
  token_guard

# ─────────────────────────────────────────────────────────────────────────────
# Auswertung
# ─────────────────────────────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))

if [[ "$OUTPUT_JSON" == "true" ]]; then
  {
    printf '{\n'
    printf '  "baseUrl": "%s",\n' "$BASE_URL"
    printf '  "version": "%s",\n' "$APP_VERSION"
    printf '  "pass": %d,\n' "$PASS"
    printf '  "fail": %d,\n' "$FAIL"
    printf '  "total": %d,\n' "$TOTAL"
    printf '  "minPass": %d,\n' "$MIN_PASS"
    printf '  "passed": %s,\n' "$( (( PASS >= MIN_PASS )) && echo true || echo false )"
    printf '  "checks": [\n'
    local_last=$(( ${#RESULTS[@]} - 1 ))
    for i in "${!RESULTS[@]}"; do
      IFS='|' read -r cid cstatus clabel cfix <<<"${RESULTS[$i]}"
      printf '    {"id":"%s","status":"%s","label":%s,"fix":%s}%s\n' \
        "$cid" "$cstatus" \
        "$(jq -Rn --arg v "$clabel" '$v')" \
        "$(jq -Rn --arg v "$cfix" '$v')" \
        "$( (( i == local_last )) && echo "" || echo "," )"
    done
    printf '  ]\n}\n'
  }
else
  printf '\n%sErgebnis: %s%d bestanden%s, %s%d fehlgeschlagen%s (von %d, benötigt %d)\n' \
    "$C_BOLD" "$C_GREEN" "$PASS" "$C_RESET" "$C_RED" "$FAIL" "$C_RESET" "$TOTAL" "$MIN_PASS"
  if (( FAIL > 0 )); then
    printf 'Fehlchecks: %s\n' "${FAILED_IDS[*]}"
    printf '%sDokumentierte Ausnahmen:%s V18 ohne FIRM_API_TOKEN · V08–V11 ohne universe:seed:markets · V16 mit --no-shorts\n' \
      "$C_DIM" "$C_RESET"
  fi
  if (( PASS >= MIN_PASS )); then
    printf '%sValidierung bestanden.%s\n' "$C_GREEN" "$C_RESET"
  else
    printf '%sValidierung NICHT bestanden — docs/INSTALL.md Kapitel „Typische Fehler“.%s\n' "$C_RED" "$C_RESET"
  fi
fi

(( PASS >= MIN_PASS )) || exit 1
exit 0
