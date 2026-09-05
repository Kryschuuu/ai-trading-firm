#!/usr/bin/env bash
#
# ═══════════════════════════════════════════════════════════════════════════
#  Autonome KI-Trading-Firma — geführte Installation auf CachyOS / Arch Linux
#  Version 1.30.0
# ═══════════════════════════════════════════════════════════════════════════
#
#   ./scripts/setup-cachyos.sh --variant a
#   ./scripts/setup-cachyos.sh --variant b --llm-host 192.168.1.50
#   ./scripts/setup-cachyos.sh --variant a --non-interactive
#   ./scripts/setup-cachyos.sh --variant a --dry-run
#
# ── Was dieses Skript tut (10 Schritte, jeder idempotent) ──────────────────
#   01 Preflight        sudo, Werkzeuge, Node ≥ 20, Projektstamm
#   02 Systempakete     nodejs npm postgresql git jq curl
#   03 PostgreSQL       Cluster prüfen/initialisieren, Dienst starten
#   04 Rolle & Datenbank  Benutzer, Datenbank, DATABASE_URL (URL-encoded)
#   05 .env             FIRM_API_TOKEN + unabhaengiges FIRM_SESSION_SECRET + Markt-Presets
#   06 Abhängigkeiten   npm ci
#   07 Schema           drizzle-kit push + Tabellen-Verifikation
#   08 Universum        universe:seed + universe:seed:markets
#                       (50 Aktien · 50 Indizes · 22 Rohstoffe · 30 Krypto)
#   09 Build            next build (muss warnungsfrei sein)
#   10 Validierung      temporärer Server + Seed + Short-Default
#                       + scripts/validate-setup.sh (18 Checks)
#
# ── Behobene Fehler gegenüber der Vorgängerversion ─────────────────────────
#  B1 PostgreSQL-Initialisierung
#     * bestehende Cluster werden NIE automatisch gelöscht (Versionsabgleich
#       VOR jedem Eingriff, bei Major-Mismatch Abbruch mit pg_upgrade-Hinweis)
#     * Locale-Handling: C.UTF-8 mit Fallback auf C, ENCODING=UTF8 immer
#     * initdb-Fehler werden abgefangen, mit Diagnose + manuellem Fahrplan
#     * Cluster-Reset nur über explizite Frage bzw. --reset-cluster
#  B2 Datenbank-Validierung
#     * agents/missions werden nach dem Seed gezählt und gemeldet
#     * Mission-IDs werden auf UUID-Form geprüft, bevor sie in einen Request
#       gehen — beendet „invalid input syntax for type uuid: \"null\""
#  B3 Broker-Adapter
#     * der aktive Adapter wird über /api/firm → account.broker verifiziert;
#       UNEXPECTED_BROKER_ADAPTER wird damit sichtbar statt rätselhaft
#  B4 Build-Warnungen
#     * Schritt 09 wertet die Build-Ausgabe aus und meldet Turbopack-Warnungen
#       laut (die 12 „Dynamic filesystem access"-Warnungen sind seit v1.30.0
#       über src/lib/appPaths.ts behoben)
#  B5 API-Validierung
#     * FIRM_API_TOKEN wird erzeugt, wenn er fehlt; offener Betrieb auf
#       0.0.0.0 ohne Token wird als SICHERHEITSWARNUNG quittiert
#     * die Ceiling-Klemmung wird mit PROZENT-Eingabe (90) geprüft, nicht mit
#       Bruch (0.9) — der alte Test konnte nur fehlschlagen
#  B6 Smoke-/Setup-Tests
#     * Validierung über scripts/validate-setup.sh: 18 Checks, bestanden ab
#       --min-pass (Default 15), jeder Fehlcheck mit Behebungszeile
#
# ── Idempotenz ─────────────────────────────────────────────────────────────
# Mehrfaches Ausführen ist sicher: vorhandene Cluster, Rollen, Datenbanken,
# .env-Werte, Tabellen und Instrumente werden erkannt und nicht überschrieben.
# Einzig `npm ci` und `next build` laufen immer (gewollt: reproduzierbar).
#
# ── Troubleshooting ────────────────────────────────────────────────────────
#   * jeder Schritt schreibt nach $LOG_FILE (Default data/setup/setup-<ts>.log)
#   * SETUP_DEBUG=1 schaltet Trace-Ausgabe ein (set -x ab Schrittbeginn)
#   * PostgreSQL-Probleme: docs/SETUP_PG_TROUBLESHOOTING.md
#   * Setup-/Validierungsfehler: docs/SETUP_BUGS.md
#
set -Eeuo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# 0. Pfade, Konstanten, Defaults
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# systemd-/Cluster-Helfer. Beide sind regression-getestet
# (tests/setupPgService.test.ts, tests/setupCluster.test.ts) und werden hier
# bewusst wiederverwendet statt dupliziert.
# shellcheck source=lib/pg-service.sh
source "$SCRIPT_DIR/lib/pg-service.sh"
# shellcheck source=lib/pg-cluster.sh
source "$SCRIPT_DIR/lib/pg-cluster.sh"

# Erwartete Mindestanzahl öffentlicher Tabellen nach `drizzle-kit push`.
# Quelle: src/lib/seed.ts → checkSchema() (14 Pflicht-Tabellen; seit v1.36.16
# inkl. venue_control_state, C4). Ein niedrigerer Wert lässt Schema-Drift
# unbemerkt durch.
REQUIRED_TABLES=14

# Erwartete Preset-Größen des Markt-Universums (src/universe/presets.ts).
PRESET_EQUITIES=50
PRESET_INDICES=50
PRESET_COMMODITIES=22
PRESET_CRYPTO=30

# ── CLI-Defaults ────────────────────────────────────────────────────────────
VARIANT=""
LLM_HOST="127.0.0.1"
DB_NAME="trading_firm"
DB_USER="trader"
DB_HOST="127.0.0.1"
DB_PORT="5432"
DB_PASS=""
APP_PORT="${PORT:-3369}"
PGDATA="${PGDATA:-/var/lib/postgres/data}"
PG_SVC="${PG_SERVICE:-postgresql.service}"
# Cluster-Benutzer. Wird LAUFZEIT gelesen, damit tests/setupCluster.test.ts ihn
# umbiegen kann.
PG_SUDO_USER="${PG_SUDO_USER:-postgres}"

ALLOW_SHORTS="true"          # FEATURE v1.30.0: Short-Selling per Default AN
GENERATE_API_TOKEN="true"    # SECURITY: offener 0.0.0.0-Betrieb ohne Token ist riskant
API_TOKEN=""
DO_BUILD="true"
DO_VALIDATE="true"
DO_SYNC_MARKETS="false"
RESET_CLUSTER="false"
NON_INTERACTIVE="false"
DRY_RUN="false"
MIN_PASS="15"
LOG_FILE=""

# ─────────────────────────────────────────────────────────────────────────────
# 1. Logging — strukturiert, farbfrei in Pipes, immer mit Zeitstempel ins Log
# ─────────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  C_RESET=$'\e[0m'; C_BOLD=$'\e[1m'; C_GREEN=$'\e[32m'
  C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_CYAN=$'\e[36m'; C_DIM=$'\e[2m'
else
  C_RESET=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_DIM=""
fi

STEP_NO=0
STEP_TOTAL=10
CURRENT_STEP="(Init)"

# Alle Ausgaben landen zusätzlich in $LOG_FILE (ohne Farbcodes).
_log_to_file() {
  [[ -n "$LOG_FILE" ]] || return 0
  printf '%s [%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$CURRENT_STEP" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

info()  { printf '%s==>%s %s\n' "$C_CYAN" "$C_RESET" "$*";   _log_to_file "INFO  $*"; }
ok()    { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*";  _log_to_file "OK    $*"; }
warn()  { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; _log_to_file "WARN  $*"; }
note()  { printf '  %s·%s %s\n' "$C_DIM" "$C_RESET" "$*";    _log_to_file "NOTE  $*"; }

# Fehler mit Kontext + Log-Verweis, dann sauberer Abbruch.
die() {
  printf '  %s✗ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2
  _log_to_file "FATAL $*"
  if [[ -n "$LOG_FILE" ]]; then
    printf '\n%sVollständiges Log:%s %s\n' "$C_DIM" "$C_RESET" "$LOG_FILE" >&2
  fi
  exit 1
}

# Schritt-Überschrift mit Fortschrittszähler.
step() {
  STEP_NO=$((STEP_NO + 1))
  CURRENT_STEP="$1"
  printf '\n%s── Schritt %d/%d — %s ──%s\n' "$C_BOLD" "$STEP_NO" "$STEP_TOTAL" "$1" "$C_RESET"
  _log_to_file "=== Schritt ${STEP_NO}/${STEP_TOTAL}: $1 ==="
}

# Zeigt jedes Systemkommando an, bevor es läuft (Nachvollziehbarkeit), und
# hängt stdout+stderr ans Log.
run() {
  printf '    %s$ %s%s\n' "$C_BOLD" "$*" "$C_RESET"
  _log_to_file "RUN   $*"
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '    %s(dry-run: nicht ausgeführt)%s\n' "$C_DIM" "$C_RESET"
    return 0
  fi
  "$@" 2>&1 | tee -a "${LOG_FILE:-/dev/null}"
  # `tee` verschluckt den Exit-Code — PIPESTATUS liefert den des ersten Glieds.
  return "${PIPESTATUS[0]}"
}

# Wie run(), aber die Anzeige wird um Secrets bereinigt.
# Grund: `run env DATABASE_URL=… npx drizzle-kit push` würde das DB-Passwort
# im Klartext in stdout UND ins Log schreiben. Die Ausführung selbst bleibt
# unverändert — nur die Anzeige wird maskiert.
run_masked() {
  local display=("$@") arg
  for arg in "${!display[@]}"; do
    case "${display[$arg]}" in
      DATABASE_URL=*) display[$arg]="DATABASE_URL=postgresql://…@…/…" ;;
      *"$DB_PASS"*)   [[ -n "$DB_PASS" ]] && display[$arg]="${display[$arg]//$DB_PASS/***}" ;;
    esac
  done
  printf '    %s$ %s%s\n' "$C_BOLD" "${display[*]}" "$C_RESET"
  _log_to_file "RUN   ${display[*]}"
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '    %s(dry-run: nicht ausgeführt)%s\n' "$C_DIM" "$C_RESET"
    return 0
  fi
  "$@" 2>&1 | sed -e "s|${DB_PASS:-@@no-such-secret@@}|***|g" | tee -a "${LOG_FILE:-/dev/null}"
  return "${PIPESTATUS[0]}"
}

# Wie run(), aber ohne Abbruch bei Fehler (für best-effort-Schritte).
run_soft() {
  if run "$@"; then return 0; fi
  warn "Kommando lief mit Fehler weiter: $*"
  return 0
}

ask() {
  local prompt="$1"
  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    # Im Non-Interactive-Modus gilt die Default-Antwort (2. Argument, Default: nein).
    local default="${2:-n}"
    [[ "$default" =~ ^([jJyY])$ ]] && return 0
    return 1
  fi
  local answer
  read -r -p "${C_BOLD}${prompt}${C_RESET} [j/N] " answer || return 1
  [[ "$answer" =~ ^([jJ]|[yY])$ ]]
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' fehlt — installieren: sudo pacman -S $1"
}

# ─────────────────────────────────────────────────────────────────────────────
# 2. Hilfe & Argumente
# ─────────────────────────────────────────────────────────────────────────────

usage() {
  cat <<'EOF'
Verwendung:
  ./scripts/setup-cachyos.sh --variant a|b [Optionen]

Pflicht:
  --variant a|b         a = Solo-Node (Modelle auf diesem Rechner)
                        b = Split-Node (Modelle auf einem anderen Rechner)

Konfiguration:
  --llm-host IP         IP des Modellservers (Default 127.0.0.1)
  --db-name NAME        Datenbankname   (Default trading_firm)
  --db-user USER        DB-Benutzer     (Default trader)
  --db-host HOST        DB-Host         (Default 127.0.0.1)
  --db-port PORT        DB-Port         (Default 5432)
  --pgdata PFAD         Cluster-Verzeichnis (Default /var/lib/postgres/data)
  --port PORT           App-Port        (Default 3369)

Markt & Risiko (v1.30.0):
  --no-shorts           Short-Selling deaktivieren
                        (Default: AKTIVIERT — risk_config.allowShort = 1)
  --sync-markets        Marktdaten-Warmup nach dem Seed ausführen
                        (braucht Netzwerk; ohne Flag nur Registry-Seed)

Sicherheit:
  --api-token TOKEN     FIRM_API_TOKEN explizit setzen
  --no-api-token        KEIN Token erzeugen (NICHT empfohlen: die App bindet
                        0.0.0.0 — ohne Token ist die API im LAN offen). Seit
                        v1.36.13 verweigert NODE_ENV=production den Start ohne
                        Token; das Flag schreibt deshalb AUTH_MODE=local-open
                        in die .env (Befund C1)

Ablauf:
  --skip-build          Schritt 09 (next build) überspringen
  --skip-validate       Schritt 10 (18-Check-Validierung) überspringen
  --min-pass N          Mindestanzahl bestandener Checks (Default 15 von 18)
  --reset-cluster       Cluster-Reset anbieten, falls der Check fehlschlägt
  --dry-run             nur anzeigen, was passieren würde (keine Mutation)
  --non-interactive, -y keine Rückfragen (Default-Antworten)
  --log-file PFAD       Log-Ziel (Default data/setup/setup-<Zeitstempel>.log)
  -h, --help            diese Hilfe

Beispiele:
  ./scripts/setup-cachyos.sh --variant a
  ./scripts/setup-cachyos.sh --variant b --llm-host 192.168.1.50 --sync-markets
  ./scripts/setup-cachyos.sh --variant a -y --skip-validate
EOF
}

# Benötigt ein Wert-Argument; bricht mit klarer Meldung ab, wenn es fehlt.
need_value() {
  [[ $# -ge 2 && -n "${2:-}" ]] || { usage >&2; die "Option '$1' braucht einen Wert."; }
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant)          need_value "$@"; VARIANT="${2,,}"; shift 2 ;;
    --llm-host)         need_value "$@"; LLM_HOST="$2"; shift 2 ;;
    --db-name)          need_value "$@"; DB_NAME="$2"; shift 2 ;;
    --db-user)          need_value "$@"; DB_USER="$2"; shift 2 ;;
    --db-host)          need_value "$@"; DB_HOST="$2"; shift 2 ;;
    --db-port)          need_value "$@"; DB_PORT="$2"; shift 2 ;;
    --pgdata)           need_value "$@"; PGDATA="$2"; shift 2 ;;
    --port)             need_value "$@"; APP_PORT="$2"; shift 2 ;;
    --api-token)        need_value "$@"; API_TOKEN="$2"; GENERATE_API_TOKEN="false"; shift 2 ;;
    --no-api-token)     GENERATE_API_TOKEN="false"; shift ;;
    --no-shorts)        ALLOW_SHORTS="false"; shift ;;
    --sync-markets)     DO_SYNC_MARKETS="true"; shift ;;
    --skip-build)       DO_BUILD="false"; shift ;;
    --skip-validate)    DO_VALIDATE="false"; shift ;;
    --min-pass)         need_value "$@"; MIN_PASS="$2"; shift 2 ;;
    --reset-cluster)    RESET_CLUSTER="true"; shift ;;
    --dry-run)          DRY_RUN="true"; shift ;;
    --non-interactive|-y) NON_INTERACTIVE="true"; shift ;;
    --log-file)         need_value "$@"; LOG_FILE="$2"; shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    *)                  usage >&2; die "Unbekannte Option: $1  (--help für Hilfe)" ;;
  esac
done

# ── Eingaben hart validieren (sie landen in SQL, URLs und systemd-Aufrufen) ──
[[ "$VARIANT" == "a" || "$VARIANT" == "b" ]] || { usage >&2; die "--variant a oder b angeben."; }
[[ "$DB_USER" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] \
  || die "Ungültiger DB-Benutzername: '$DB_USER' (erlaubt: a-z, 0-9, _, Start mit Buchstabe oder _)."
[[ "$DB_NAME" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]] \
  || die "Ungültiger DB-Name: '$DB_NAME' (erlaubt: a-zA-Z, 0-9, _, Start mit Buchstabe oder _)."
[[ "$DB_HOST" =~ ^[A-Za-z0-9._-]{1,253}$ ]] || die "Ungültiger DB-Host: '$DB_HOST'."
[[ "$DB_PORT" =~ ^[0-9]{1,5}$ ]] || die "Ungültiger DB-Port: '$DB_PORT'."
[[ "$APP_PORT" =~ ^[0-9]{1,5}$ ]] || die "Ungültiger App-Port: '$APP_PORT'."
[[ "$MIN_PASS" =~ ^[0-9]+$ && "$MIN_PASS" -ge 1 && "$MIN_PASS" -le 18 ]] \
  || die "--min-pass muss zwischen 1 und 18 liegen (war: '$MIN_PASS')."
[[ "$LLM_HOST" =~ ^[A-Za-z0-9._-]{1,253}$ ]] || die "Ungültiger --llm-host: '$LLM_HOST'."
[[ "$PGDATA" == /* ]] || die "--pgdata muss ein absoluter Pfad sein (war: '$PGDATA')."

# ── Log-Datei vorbereiten ───────────────────────────────────────────────────
if [[ -z "$LOG_FILE" ]]; then
  LOG_FILE="$PROJECT_ROOT/data/setup/setup-$(date -u '+%Y%m%d-%H%M%S').log"
fi
if [[ "$DRY_RUN" != "true" ]]; then
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  : >"$LOG_FILE" 2>/dev/null || LOG_FILE=""
fi
[[ -n "$LOG_FILE" ]] || warn "Log-Datei nicht schreibbar — es wird nur auf stdout geloggt."

# ── Fehlerfalle: jeder unerwartete Abbruch meldet Zeile + Schritt ───────────
on_error() {
  local exit_code=$1 line=$2
  printf '\n%sAbbruch in Schritt „%s" (Zeile %s, Exit %s).%s\n' \
    "$C_RED" "$CURRENT_STEP" "$line" "$exit_code" "$C_RESET" >&2
  [[ -n "$LOG_FILE" ]] && printf 'Log: %s\n' "$LOG_FILE" >&2
  printf 'Hilfe: docs/SETUP_BUGS.md · docs/SETUP_PG_TROUBLESHOOTING.md\n' >&2
}
trap 'on_error $? $LINENO' ERR

# ─────────────────────────────────────────────────────────────────────────────
# 3. Schritt 01 — Preflight
# ─────────────────────────────────────────────────────────────────────────────
step_01_preflight() {
  step "Preflight"

  cd "$PROJECT_ROOT" || die "Projektstamm nicht erreichbar: $PROJECT_ROOT"
  ok "Projektstamm: $PROJECT_ROOT"

  # Arch/CachyOS-Erkennung: pacman ist das verbindliche Merkmal. Auf anderen
  # Distributionen bricht das Skript ab, statt halb zu funktionieren.
  if command -v pacman >/dev/null 2>&1; then
    if grep -qi 'cachyos' /etc/os-release 2>/dev/null; then
      ok "Betriebssystem: CachyOS"
    else
      note "Betriebssystem: Arch-basiert (nicht CachyOS) — Paketnamen stimmen überein."
    fi
  else
    die "pacman fehlt — dieses Skript ist für CachyOS/Arch geschrieben."
  fi

  require_cmd sudo
  require_cmd curl
  require_cmd jq

  # sudo-Berechtigung prüfen. Ein Passwort-Prompt ist normal (interaktiv);
  # nur eine echte Verweigerung ist ein Abbruchgrund.
  if ! sudo -n true >/dev/null 2>&1; then
    local sudo_err
    sudo_err="$(sudo -n true 2>&1 || true)"
    case "$sudo_err" in
      *"not in the sudoers"*|*"not authorized"*|*"is not allowed to run sudo"*|*"not in sudoers"*)
        die "Dein Benutzer darf kein sudo: usermod -aG wheel $USER, neu anmelden, dann /etc/sudoers prüfen."
        ;;
      *)
        note "sudo fragt nach einem Passwort (normal)."
        ;;
    esac
  fi
  ok "sudo verfügbar."

  # Cluster-Benutzer muss existieren, sonst sind alle pg_as_postgres-Aufrufe tot.
  if ! id "$PG_SUDO_USER" >/dev/null 2>&1; then
    die "Benutzer '$PG_SUDO_USER' existiert nicht — postgresql-Paket prüfen (pacman -Q postgresql) und neu installieren."
  fi
  ok "Cluster-Prüfungen laufen als Benutzer '$PG_SUDO_USER'."

  # Node-Version: package.json verlangt >= 20.
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if (( node_major < 20 )); then
    die "Node.js 20+ nötig, gefunden: $(node --version 2>/dev/null || echo 'keins')"
  fi
  ok "Node.js $(node --version) · npm $(npm --version)"
}

# ─────────────────────────────────────────────────────────────────────────────
# 4. Schritt 02 — Systempakete
# ─────────────────────────────────────────────────────────────────────────────
step_02_packages() {
  step "Systempakete"

  local missing=() pkg
  for pkg in nodejs npm postgresql git jq curl; do
    pacman -Qi "$pkg" &>/dev/null || missing+=("$pkg")
  done

  if (( ${#missing[@]} == 0 )); then
    ok "Alle Systempakete vorhanden."
    return 0
  fi

  warn "Es fehlen: ${missing[*]}"
  if ask "Jetzt mit pacman installieren?" y; then
    run sudo pacman -S --needed --noconfirm "${missing[@]}" \
      || die "pacman-Installation fehlgeschlagen. Manuell: sudo pacman -S ${missing[*]}"
    ok "Pakete installiert."
  else
    die "Ohne diese Pakete geht es nicht weiter: ${missing[*]}"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 5. Schritt 03 — PostgreSQL-Cluster
#
# Reihenfolge ist sicherheitskritisch:
#   1. Sicherheitsgurt: nutzt postgresql.service wirklich $PGDATA?
#   2. Versionsabgleich Cluster ↔ Server (VOR jedem Eingriff!)
#   3. Cluster-Validierung als $PG_SUDO_USER (kein EACCES-Fehlalarm)
#   4. nur bei Defekt: Dienst stoppen → Lockfile prüfen → Reset anbieten
#   5. initdb mit Locale-Fallback + Fehlerbehandlung
#   6. Dienst starten und mit pg_isready auf echte Bereitschaft warten
# ─────────────────────────────────────────────────────────────────────────────

# Dienst stoppen und auf den Zielzustand warten. 'activating' wird mitbehandelt,
# weil systemd-Auto-Restart-Schleifen (Restart=on-failure) genau dort stehen.
pg_service_stoppen() {
  local state i
  state="$(systemctl show -p ActiveState --value "$PG_SVC" 2>/dev/null || true)"
  case "$state" in
    active|activating|reloading) ;;
    *) return 0 ;;
  esac
  run sudo systemctl stop "$PG_SVC" || true
  for i in $(seq 1 15); do
    state="$(systemctl show -p ActiveState --value "$PG_SVC" 2>/dev/null || true)"
    [[ "$state" == "inactive" || "$state" == "failed" ]] && return 0
    sleep 1
  done
  warn "$PG_SVC stoppt nicht (State: $state) — letzte Logzeilen:"
  sudo journalctl -u "$PG_SVC" -n 15 --no-pager 2>/dev/null | sed 's/^/    /' || true
  die "Dienst stoppt nicht. Manuell: sudo systemctl stop $PG_SVC — siehe docs/SETUP_PG_TROUBLESHOOTING.md Abschnitt 5."
}

# Veraltete postmaster.pid entfernen.
# Rückgabe 1 = der Cluster-Prozess LEBT noch → Aufrufer MUSS abbrechen,
# sonst droht Datenverlust durch rm/initdb unter einem laufenden Server.
pg_cleanup_stale_pid() {
  local pid=""
  pg_as_postgres test -f "$PGDATA/postmaster.pid" || return 0
  pid="$(pg_as_postgres head -1 "$PGDATA/postmaster.pid" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    warn "Cluster läuft noch (postmaster.pid → PID $pid). Erst stoppen:"
    warn "  sudo systemctl stop $PG_SVC"
    warn "  oder: sudo -u $PG_SUDO_USER pg_ctl -D $PGDATA stop"
    return 1
  fi
  warn "Veraltete postmaster.pid gefunden (Prozess ${pid:-?} läuft nicht) — wird entfernt."
  pg_as_postgres rm -f "$PGDATA/postmaster.pid" || true
  return 0
}

# Verfügbare UTF-8-Locale bestimmen: C.UTF-8 ist auf Arch Standard, fehlt sie,
# fällt das Skript auf C zurück (initdb bricht sonst mit
# „locale \"C.UTF-8\" does not exist" ab).
pg_pick_locale() {
  if locale -a 2>/dev/null | grep -qiE '^C\.(utf-?8|UTF-?8)$'; then
    printf 'C.UTF-8'
    return 0
  fi
  if locale -a 2>/dev/null | grep -qiE '^en_US\.utf-?8$'; then
    printf 'en_US.UTF-8'
    return 0
  fi
  printf 'C'
}

step_03_postgres() {
  step "PostgreSQL-Cluster"

  # ── 1) Sicherheitsgurt: läuft der Dienst im erwarteten Datenverzeichnis? ──
  # systemd liefert ExecStart UNEXPANDIERT (Arch-Unit: -D ${PGROOT}/data).
  # pg_svc_datadir expandiert ${PGROOT} erst, dann wird verglichen (v1.5.3).
  local svc_pgdata
  svc_pgdata="$(pg_svc_datadir "$PG_SVC")"
  if [[ -z "$svc_pgdata" ]]; then
    warn "Datenverzeichnis von $PG_SVC nicht ermittelbar — Sicherheitsgurt übersprungen."
  elif [[ "$(pg_norm_path "$svc_pgdata")" != "$(pg_norm_path "$PGDATA")" ]]; then
    die "$PG_SVC nutzt '$svc_pgdata', erwartet war '$PGDATA'. Drop-in klären: systemctl cat $PG_SVC"
  else
    ok "$PG_SVC nutzt das erwartete Datenverzeichnis $PGDATA."
  fi

  # ── 2) Versionsabgleich VOR jedem Eingriff (Datenschutz) ──
  local pg_major data_major ctrl_major
  pg_major="$(pg_server_major)"
  [[ -n "$pg_major" ]] && ok "PostgreSQL-Server: $pg_major" \
                       || warn "Server-Version nicht ermittelbar — Versionsabgleich übersprungen."

  # Ein Major-Mismatch heißt: alte Daten, neuer Server (oder umgekehrt).
  # Automatisches initdb würde die Daten zerstören → harter Abbruch.
  if pg_version_mismatch "$pg_major" "$PGDATA"; then
    data_major="$(pg_data_version "$PGDATA")"
    die "Cluster ist PostgreSQL ${data_major}, installiert ist ${pg_major} — Major-Update, NICHT kompatibel. Kein automatisches initdb! Anleitung: docs/SETUP_PG_TROUBLESHOOTING.md Abschnitt 4 (pg_upgrade / pg_dumpall)."
  fi
  ctrl_major="$(pg_control_major "$PGDATA")"
  if [[ -n "$ctrl_major" && -n "$pg_major" && "$ctrl_major" != "$pg_major" ]]; then
    die "pg_control (Cluster $ctrl_major) passt nicht zum Server ($pg_major) — siehe docs/SETUP_PG_TROUBLESHOOTING.md Abschnitt 4 (pg_upgrade)."
  fi

  # ── 3) Cluster-Validierung (als $PG_SUDO_USER, versionstolerant) ──
  if pg_cluster_ok "$PGDATA"; then
    ok "Cluster unter $PGDATA vollständig (Version $(pg_data_version "$PGDATA"))."
  else
    warn "Cluster-Check fehlgeschlagen — Diagnose (läuft als $PG_SUDO_USER):"
    pg_cluster_diagnostics "$PGDATA"

    # Dienst stoppen, BEVOR am Datenverzeichnis gearbeitet wird: ein aktiver
    # oder auto-restartender Server könnte genau während initdb wieder hochkommen.
    pg_service_stoppen
    pg_cleanup_stale_pid \
      || die "Cluster-Instanz läuft noch — wie oben stoppen, dann erneut ausführen."

    local pg_state
    pg_state="$(pg_control_state "$PGDATA")"
    if [[ "$pg_state" == *"running"* || "$pg_state" == *"in production"* ]]; then
      die "pg_controldata meldet: $pg_state. Cluster zuerst stoppen (sudo systemctl stop $PG_SVC)."
    fi

    if [[ "$RESET_CLUSTER" == "true" ]] || ask "Cluster neu initialisieren? (Vorhandene Daten in $PGDATA gehen verloren)"; then
      pg_reset_cluster
    else
      die "Ohne vollständig initialisierten Cluster geht es nicht weiter. Manuell: sudo -u $PG_SUDO_USER initdb -D $PGDATA --locale=C.UTF-8 --encoding=UTF8"
    fi
  fi

  # ── 5) Nach-initdb-Verifikation ──
  if ! pg_cluster_ok "$PGDATA"; then
    warn "Cluster nach initdb weiterhin unvollständig — Diagnose:"
    pg_cluster_diagnostics "$PGDATA"
    cat <<'RECOVER'

  Manuell prüfen (einzeln, NICHT als root):

    sudo -u postgres ls -la /var/lib/postgres/data /var/lib/postgres/data/global
    sudo -u postgres pg_controldata -D /var/lib/postgres/data
    df -h /var/lib/postgres
    sudo journalctl -u postgresql -n 30 --no-pager

  Danach (Cluster ist bereits initialisiert — NICHT erneut löschen!):

    sudo systemctl start postgresql
    pg_isready
    ./scripts/setup-cachyos.sh --variant a

  Ausführlich: docs/SETUP_PG_TROUBLESHOOTING.md

RECOVER
    die "initdb hat keinen brauchbaren Cluster erzeugt. Siehe Anleitung oben."
  fi

  # ── 6) Dienst starten (mit Fremdinstanz-Erkennung) ──
  pg_service_start
  pg_wait_ready
}

# Cluster zurücksetzen und neu initialisieren. Nur nach expliziter Zustimmung
# bzw. --reset-cluster erreichbar.
pg_reset_cluster() {
  local pg_group pg_locale
  pg_group="$(id -gn "$PG_SUDO_USER" 2>/dev/null || printf '%s' "$PG_SUDO_USER")"

  run sudo install -d -o "$PG_SUDO_USER" -g "$pg_group" "$(dirname "$PGDATA")"
  # Nur den INHALT löschen, nicht das Verzeichnis selbst (sonst stimmen
  # Besitzer/Rechte des Mountpoints nicht mehr).
  run sudo find "$PGDATA" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
  run sudo -u "$PG_SUDO_USER" mkdir -p "$PGDATA"

  # Locale-Fallback (B1): C.UTF-8 → en_US.UTF-8 → C.
  pg_locale="$(pg_pick_locale)"
  [[ "$pg_locale" == "C" ]] && warn "Keine UTF-8-Locale gefunden — initdb läuft mit 'C'."
  ok "initdb-Locale: $pg_locale (ENCODING=UTF8)"

  # initdb-Fehlerbehandlung (B1): ohne -A stünde lokale Auth auf 'trust'.
  if ! run sudo -u "$PG_SUDO_USER" initdb -D "$PGDATA" \
        --locale="$pg_locale" --encoding=UTF8 \
        --data-checksums --auth-local=peer --auth-host=scram-sha-256; then
    warn "initdb fehlgeschlagen — häufige Ursachen: Platte voll, falscher Benutzer, fehlende Locale."
    sudo journalctl -u "$PG_SVC" -n 20 --no-pager 2>/dev/null | sed 's/^/    /' || true
    die "initdb konnte keinen Cluster anlegen. Manuell: sudo -u $PG_SUDO_USER initdb -D $PGDATA --locale=$pg_locale --encoding=UTF8 --data-checksums --auth-local=peer --auth-host=scram-sha-256"
  fi
  ok "Cluster neu initialisiert."
}

# PID des Prozesses, der auf 5432 hört (leer, wenn niemand).
pg_port_listener_pid() {
  local pid=""
  if command -v ss >/dev/null 2>&1; then
    pid="$(sudo ss -ltnp "sport = :$DB_PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)"
  fi
  if [[ -z "$pid" ]] && command -v fuser >/dev/null 2>&1; then
    pid="$(sudo fuser "$DB_PORT/tcp" 2>/dev/null | tr -s ' ' | head -1 || true)"
  fi
  printf '%s' "$pid"
}

pg_service_start() {
  # Remote-DB (--db-host != localhost): kein lokaler Dienst nötig.
  if [[ "$DB_HOST" != "127.0.0.1" && "$DB_HOST" != "localhost" ]]; then
    note "Externer DB-Host '$DB_HOST' — lokaler Dienst wird nicht gestartet."
    return 0
  fi

  if systemctl is-active --quiet "$PG_SVC"; then
    ok "$PG_SVC läuft bereits."
    return 0
  fi

  local port_pid port_args
  port_pid="$(pg_port_listener_pid)"
  if [[ -n "$port_pid" ]]; then
    port_args="$(ps -o args= -p "$port_pid" 2>/dev/null || true)"
    if [[ "$port_args" == *"$PGDATA"* ]]; then
      warn "PostgreSQL läuft bereits auf Port $DB_PORT (PID $port_pid), aber nicht unter systemd — vermutlich manuell per pg_ctl gestartet. Das Skript nutzt diese Instanz weiter."
      return 0
    fi
    die "Port $DB_PORT ist durch einen fremden Prozess belegt (PID $port_pid): $(ps -o user=,args= -p "$port_pid" 2>/dev/null). Prüfen: sudo ss -ltnp 'sport = :$DB_PORT'"
  fi

  pg_cleanup_stale_pid \
    || die "Cluster-Instanz lebt, lauscht aber nicht auf Port $DB_PORT — unklarer Zustand, bitte manuell klären."

  if ! run sudo systemctl enable --now "$PG_SVC"; then
    warn "systemctl start fehlgeschlagen — letzte Logzeilen:"
    sudo journalctl -u "$PG_SVC" -n 20 --no-pager 2>/dev/null | sed 's/^/    /' || true
    die "Siehe docs/SETUP_PG_TROUBLESHOOTING.md (Schritte 1–6)."
  fi
}

# Warten auf ECHTE Annahmebereitschaft. `systemctl is-active` meldet
# Type=forking-Dienste schon als aktiv, bevor der Server Connections nimmt.
pg_wait_ready() {
  info "Warte auf PostgreSQL-Bereitschaft (max. 30 s)…"
  local _
  for _ in $(seq 1 30); do
    if pg_isready -q -t 1 -h "$DB_HOST" -p "$DB_PORT" \
       || pg_isready -q -t 1; then
      ok "PostgreSQL nimmt Verbindungen an ($DB_HOST:$DB_PORT)."
      return 0
    fi
    sleep 1
  done
  warn "PostgreSQL nimmt nach 30 s keine Verbindungen an. Letzte Logzeilen:"
  sudo journalctl -u "$PG_SVC" -n 15 --no-pager 2>/dev/null | sed 's/^/      /' || true
  die "PostgreSQL nicht bereit. Dieses Skript erneut ausführen — es erkennt und repariert halb initialisierte Cluster selbst."
}

# ─────────────────────────────────────────────────────────────────────────────
# 6. Schritt 04 — Rolle, Datenbank, DATABASE_URL
# ─────────────────────────────────────────────────────────────────────────────

# Superuser-psql auf dem Cluster (peer-Auth als $PG_SUDO_USER).
pg_psql() {
  sudo -u "$PG_SUDO_USER" psql -X -v ON_ERROR_STOP=1 "$@"
}

step_04_database() {
  step "Rolle & Datenbank"

  # Harte SQL-Verifikation als Superuser, BEVOR Passwörter abgefragt werden.
  if [[ "$DB_HOST" == "127.0.0.1" || "$DB_HOST" == "localhost" ]]; then
    pg_psql -tAc "SELECT 1" &>/dev/null \
      || die "Superuser-Verbindung scheitert (sudo -u $PG_SUDO_USER psql). 'journalctl -u $PG_SVC -n 50' prüfen."
    ok "Superuser-Verbindung steht."
  else
    note "Externer DB-Host — Superuser-Prüfung übersprungen."
  fi

  local role_exists=""
  if [[ "$DB_HOST" == "127.0.0.1" || "$DB_HOST" == "localhost" ]]; then
    role_exists="$(pg_psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" 2>/dev/null | tr -d '[:space:]' || true)"
  fi

  if [[ -n "$role_exists" ]]; then
    ok "Rolle '${DB_USER}' existiert bereits."
    if [[ -z "$DB_PASS" ]]; then
      if [[ "$NON_INTERACTIVE" == "true" ]]; then
        die "Rolle '${DB_USER}' existiert, aber kein Passwort angegeben. Im Non-Interactive-Modus DB_PASS als Umgebungsvariable setzen."
      fi
      # read -r -s: keine Echo-Ausgabe, kein Backslash-Escaping.
      read -r -s -p "  Passwort von '${DB_USER}' für die .env: " DB_PASS; echo
      [[ -n "$DB_PASS" ]] || die "Passwort für die .env darf nicht leer sein."
    fi
  else
    if [[ -z "$DB_PASS" ]]; then
      if [[ "$NON_INTERACTIVE" == "true" ]]; then
        die "Neue Rolle '${DB_USER}' braucht ein Passwort. Im Non-Interactive-Modus DB_PASS als Umgebungsvariable setzen."
      fi
      read -r -s -p "  Neues Passwort für '${DB_USER}': " DB_PASS; echo
      [[ -n "$DB_PASS" ]] || die "Leeres Passwort ist keine gute Idee."
    fi
    # Injection-/Quote-sicher: Werte gehen als psql-Variablen hinein;
    # :\"var\" bzw. :'var' maskieren kontextsicher. Ein ' im Passwort bricht
    # damit nichts mehr (v1.5.3-Fix).
    pg_psql -v db_user="$DB_USER" -v db_name="$DB_NAME" -v db_pass="$DB_PASS" <<'SQL'
CREATE USER :"db_user" WITH PASSWORD :'db_pass';
CREATE DATABASE :"db_name" OWNER :"db_user";
GRANT ALL PRIVILEGES ON DATABASE :"db_name" TO :"db_user";
SQL
    ok "Rolle '${DB_USER}' und Datenbank '${DB_NAME}' angelegt."
  fi

  # Existiert die Datenbank schon (zweiter Lauf)? Idempotenz-Absicherung.
  local db_exists
  db_exists="$(pg_psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -z "$db_exists" && ( "$DB_HOST" == "127.0.0.1" || "$DB_HOST" == "localhost" ) ]]; then
    pg_psql -v db_user="$DB_USER" -v db_name="$DB_NAME" <<'SQL'
CREATE DATABASE :"db_name" OWNER :"db_user";
GRANT ALL PRIVILEGES ON DATABASE :"db_name" TO :"db_user";
SQL
    ok "Datenbank '${DB_NAME}' nachträglich angelegt."
  fi

  # Passwort URL-encoden, BEVOR es in die Connection-URI wandert: @ : / % + &
  # brechen sonst psql, node-postgres und drizzle-kit (v1.5.3-Fix).
  require_cmd jq
  DB_PASS_ENC="$(jq -rn --arg v "$DB_PASS" '$v | @uri')"
  DATABASE_URL="postgresql://${DB_USER}:${DB_PASS_ENC}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

  psql "$DATABASE_URL" -c "SELECT 1;" &>/dev/null \
    || die "Verbindung zur Datenbank schlägt fehl. DATABASE_URL: postgresql://${DB_USER}:***@${DB_HOST}:${DB_PORT}/${DB_NAME}"
  ok "Datenbankverbindung steht (${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME})."

  # Server-Encoding prüfen: bei SQL_ASCII würden Umlaute in Missionstexten
  # („Erste Paper-Mission") beim Seed beschädigt.
  local enc
  enc="$(psql "$DATABASE_URL" -tAc 'SHOW server_encoding;' 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -n "$enc" && "${enc^^}" != "UTF8" ]]; then
    warn "Server-Encoding ist '$enc', erwartet UTF8 — Umlaute können beschädigt werden."
    warn "Behebung: Cluster mit --encoding=UTF8 neu initialisieren (docs/SETUP_PG_TROUBLESHOOTING.md Abschnitt 4)."
  else
    ok "Server-Encoding: ${enc:-UTF8}."
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 7. Schritt 05 — .env
#
# Idempotenz: Eine vorhandene .env wird NIE still überschrieben. Fehlende
# Schluessel werden ergaenzt (Auth-Token + Session-Secret), vorhandene bleiben.
# ─────────────────────────────────────────────────────────────────────────────

# Erzeugt ein kryptografisch zufälliges Token (64 Hex-Zeichen).
generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    # Fallback ohne openssl: /dev/urandom + od. Kein Zufallsersatz aus $RANDOM.
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Schreibt KEY=VALUE in .env, wenn der Schlüssel fehlt (sonst unverändert).
env_ensure_key() {
  local key="$1" value="$2" file="$3"
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    return 1  # vorhanden
  fi
  printf '%s=%s\n' "$key" "$value" >>"$file"
  return 0
}

step_05_env() {
  step "Konfiguration (.env)"

  cd "$PROJECT_ROOT"
  local env_file="$PROJECT_ROOT/.env"
  local created="false"

  if [[ -f "$env_file" ]]; then
    if [[ "$NON_INTERACTIVE" == "true" ]] || ! ask "Vorhandene .env überschreiben? (fehlende Schlüssel werden sonst nur ergänzt)"; then
      ok "Bestehende .env bleibt erhalten — fehlende Schlüssel werden ergänzt."
      # Bestehende DATABASE_URL übernehmen, damit Schritt 07/10 dieselbe DB nutzen.
      local existing_url
      existing_url="$(sed -n 's/^DATABASE_URL=//p' "$env_file" | tail -1 || true)"
      if [[ -n "$existing_url" && "$existing_url" != "$DATABASE_URL" ]]; then
        warn ".env enthält eine andere DATABASE_URL — sie hat Vorrang vor der hier erzeugten."
        DATABASE_URL="$existing_url"
      fi
    else
      cp "$env_file" "${env_file}.bak-$(date -u '+%Y%m%d-%H%M%S')"
      ok "Sicherungskopie der alten .env angelegt."
      created="true"
    fi
  else
    created="true"
  fi

  # ── API-Token (B5, gehärtet in C1/v1.36.13) ─────────────────────────────
  # npm start bindet 0.0.0.0 (package.json) UND setzt NODE_ENV=production.
  # Seit v1.36.13 ist der offene Local-Mode kein Default mehr: ohne irgendein
  # Token wirft der Boot-Guard (src/auth/authMode.ts) und der Dienst startet
  # nicht. Offen laufen kann nur, wer AUTH_MODE=local-open ausdrücklich setzt.
  OPEN_MODE_REQUESTED="false"
  if [[ -n "$API_TOKEN" ]]; then
    note "FIRM_API_TOKEN aus --api-token übernommen."
  elif grep -qE '^FIRM_API_TOKEN=.+' "$env_file" 2>/dev/null; then
    ok "FIRM_API_TOKEN bereits gesetzt."
  elif [[ "$GENERATE_API_TOKEN" == "true" ]]; then
    API_TOKEN="$(generate_token)"
    [[ -n "$API_TOKEN" ]] || die "Token-Erzeugung fehlgeschlagen (openssl rand)."
    note "Neues FIRM_API_TOKEN erzeugt (wird in .env geschrieben, Rechte 600)."
  else
    API_TOKEN=""
    OPEN_MODE_REQUESTED="true"
    warn "KEIN FIRM_API_TOKEN (--no-api-token) — die App bindet 0.0.0.0, die Schreib-API ist im LAN offen."
    warn "Seit v1.36.13 (Befund C1) verweigert NODE_ENV=production den Start ohne jedes Token."
    warn "Deshalb wird AUTH_MODE=local-open in .env eingetragen — ein bewusster, dokumentierter Opt-in."
    warn "Nur in einer vertrauenswürdigen, isolierten Umgebung vertretbar. Empfohlen: Token erzeugen lassen."
  fi

  # ── Modelle je Variante ──────────────────────────────────────────────────
  local m_big m_sml m_cod m_exec ctx
  if [[ "$VARIANT" == "a" ]]; then
    m_big="qwen2.5:3b-instruct-q4_K_M"; m_sml="qwen2.5:3b-instruct-q4_K_M"
    m_cod="qwen2.5:3b-instruct-q4_K_M"; m_exec="qwen2.5:1.5b-instruct-q4_K_M"
    ctx=4096
  else
    m_big="qwen2.5:14b-instruct-q4_K_M"; m_sml="qwen2.5:7b-instruct-q4_K_M"
    m_cod="qwen2.5-coder:7b";            m_exec="qwen2.5:7b-instruct-q4_K_M"
    ctx=8192
  fi

  if [[ "$created" == "true" && "$DRY_RUN" != "true" ]]; then
    cat >"$env_file" <<ENV
# Erzeugt von scripts/setup-cachyos.sh — Variante ${VARIANT^^}, $(date -u '+%Y-%m-%d %H:%M UTC')
# Rechte 600: diese Datei enthält Zugangsdaten.

# --- Datenbank (Pflicht) ---------------------------------------------------
DATABASE_URL=${DATABASE_URL}

# --- Modellserver ----------------------------------------------------------
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://${LLM_HOST}:11434
OLLAMA_NUM_CTX=${ctx}
LLM_TIMEOUT_MS=180000
LLM_MAX_TOKENS=512

# --- Modelle je Agenten-Rolle ----------------------------------------------
MODEL_CEO=${m_big}
MODEL_RESEARCH=${m_sml}
MODEL_BACKTEST=${m_cod}
MODEL_RISK=${m_sml}
MODEL_APPROVER=${m_sml}
MODEL_EXECUTOR=${m_exec}

# --- Firma / Risiko --------------------------------------------------------
STARTING_EQUITY=10000
REQUIRE_HUMAN_APPROVAL=false
PORT=${APP_PORT}

# --- Markt-Universum (v1.30.0) ---------------------------------------------
# 50 Aktien · 50 Indizes · 22 Rohstoffe · 30 Kryptowährungen
# (Preset-Definition: src/universe/presets.ts)
UNIVERSE_DATA_DIR=data/universe

# --- Marktdaten-Sync (MDSYNC-001) ------------------------------------------
MARKET_SYNC_ENABLED=true

# --- Paper-Trading ---------------------------------------------------------
# Erlaubt: synthetic | broker-market-data | broker-paper-api (parsePaperMode()).
# A/B/C werden NICHT akzeptiert (Befund B7 in docs/SETUP_BUGS.md).
PAPER_MODE=broker-market-data
PAPER_STATIC_FALLBACK=false
ENV
    ok ".env neu geschrieben."
  fi

  # ── Schlüssel ergänzen (idempotent, auch bei bestehender .env) ───────────
  if [[ "$DRY_RUN" != "true" ]]; then
    # SEC-01: neue Secrets nie in eine noch gruppen-/weltlesbare Datei schreiben.
    chmod 600 "$env_file"
    local added=0
    if ! grep -qE '^[[:space:]]*(export[[:space:]]+)?FIRM_SESSION_SECRET[[:space:]]*=' "$env_file"; then
      local session_secret
      session_secret="$(generate_token)" || die "Session-Secret-Erzeugung fehlgeschlagen."
      [[ "$session_secret" =~ ^[a-f0-9]{64}$ ]] || die "Session-Secret-Erzeugung lieferte keinen sicheren Zufallswert."
      env_ensure_key "FIRM_SESSION_SECRET" "$session_secret" "$env_file" && added=$((added+1))
      unset session_secret
      note "Unabhaengiges FIRM_SESSION_SECRET erzeugt (nur .env, nie im Log)."
    fi
    # Vorhandene Werte niemals still rotieren; ungueltige Werte meldet der Boot-Guard.
    env_ensure_key "DATABASE_URL"      "$DATABASE_URL"                 "$env_file" && added=$((added+1))
    env_ensure_key "PORT"              "$APP_PORT"                     "$env_file" && added=$((added+1))
    env_ensure_key "STARTING_EQUITY"   "10000"                         "$env_file" && added=$((added+1))
    env_ensure_key "LLM_PROVIDER"      "ollama"                        "$env_file" && added=$((added+1))
    env_ensure_key "OLLAMA_BASE_URL"   "http://${LLM_HOST}:11434"      "$env_file" && added=$((added+1))
    env_ensure_key "UNIVERSE_DATA_DIR" "data/universe"                 "$env_file" && added=$((added+1))
    env_ensure_key "MARKET_SYNC_ENABLED" "true"                        "$env_file" && added=$((added+1))
    env_ensure_key "PAPER_MODE"        "broker-market-data"            "$env_file" && added=$((added+1))
    if [[ -n "$API_TOKEN" ]]; then
      env_ensure_key "FIRM_API_TOKEN"  "$API_TOKEN"                    "$env_file" && added=$((added+1))
    fi
    # C1 (v1.36.13): Produktion ohne Token verweigert den Start (Boot-Guard in
    # src/instrumentation.ts). Wer --no-api-token waehlt, bekommt den Offen-
    # Betrieb deshalb als ausdruecklichen Opt-in in die .env geschrieben.
    if [[ "$OPEN_MODE_REQUESTED" == "true" ]]; then
      env_ensure_key "AUTH_MODE"       "local-open"                    "$env_file" && added=$((added+1))
    fi
    (( added > 0 )) && ok "${added} fehlende(r) Schlüssel in .env ergänzt." \
                    || note "Alle benötigten Schlüssel sind bereits in .env vorhanden."

    chmod 600 .env
    ok ".env Rechte: 600."
  else
    note "(dry-run) .env würde geschrieben/ergänzt und auf 600 gesetzt."
  fi

  # Token aus der .env lesen, falls es aus einer früheren Installation stammt
  # (sonst könnte Schritt 10 keine autorisierten Requests stellen).
  if [[ -z "$API_TOKEN" ]]; then
    API_TOKEN="$(sed -n 's/^FIRM_API_TOKEN=//p' "$env_file" 2>/dev/null | tail -1 || true)"
    API_TOKEN="${API_TOKEN%$'\r'}"
    [[ -n "$API_TOKEN" ]] && ok "FIRM_API_TOKEN aus bestehender .env übernommen."
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 8. Schritt 06 — Modellserver & Abhängigkeiten
# ─────────────────────────────────────────────────────────────────────────────
step_06_dependencies() {
  step "Modellserver & Abhängigkeiten"

  # Modellserver: kein Abbruchgrund — ohne ihn läuft die deterministische
  # Regel-Engine. Nur warnen und die Konsequenz benennen.
  if curl -s --max-time 3 "http://${LLM_HOST}:11434/api/tags" >/dev/null 2>&1; then
    local count
    count="$(curl -s --max-time 5 "http://${LLM_HOST}:11434/api/tags" | jq '.models | length' 2>/dev/null || echo '?')"
    ok "Ollama erreichbar auf ${LLM_HOST} (${count} Modelle)."
  else
    warn "Ollama auf ${LLM_HOST}:11434 nicht erreichbar."
    warn "Das System startet trotzdem und nutzt die deterministische Regel-Engine."
    [[ "$VARIANT" == "b" ]] && warn "Variante B: docs/INSTALL.md Kapitel 8.1 (LAN-Freigabe) prüfen."
  fi

  # npm ci statt npm install: reproduzierbar aus package-lock.json.
  run npm ci --no-audit --no-fund \
    || die "npm ci fehlgeschlagen — package-lock.json und Netzwerk prüfen."
  ok "Node-Abhängigkeiten installiert."
}

# ─────────────────────────────────────────────────────────────────────────────
# 9. Schritt 07 — Datenbankschema
# ─────────────────────────────────────────────────────────────────────────────
step_07_schema() {
  step "Datenbankschema"

  # DATABASE_URL explizit übergeben: eine etwaige alte drizzle.config.json mit
  # harter URL hätte sonst auf die falsche Datenbank gepusht (v1.5.x-Vorfall).
  # run_masked statt run: die URL enthält das DB-Passwort.
  run_masked env DATABASE_URL="$DATABASE_URL" npx drizzle-kit push --force \
    || die "drizzle-kit push fehlgeschlagen. DATABASE_URL prüfen; Details im Log."

  # Verifikation mit Retry: PostgreSQL kann kurz brauchen, bis die Kataloge
  # konsistent sichtbar sind. Erwartet werden die Pflicht-Tabellen aus
  # src/lib/seed.ts → checkSchema().
  local tables="" attempt
  for attempt in 1 2 3 4 5; do
    sleep 1
    tables="$(psql "$DATABASE_URL" -tAc \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo 0)"
    tables="$(printf '%s' "$tables" | tr -cd '0-9')"
    [[ -n "$tables" ]] || tables=0
    (( tables >= REQUIRED_TABLES )) && break
    warn "Versuch ${attempt}/5: ${tables} Tabellen vorhanden (erwartet ≥ ${REQUIRED_TABLES})…"
  done
  if (( tables < REQUIRED_TABLES )); then
    die "Nur ${tables} Tabellen angelegt (erwartet ≥ ${REQUIRED_TABLES}). Debug: psql \"\$DATABASE_URL\" -c '\\\\dt'"
  fi
  ok "${tables} Tabellen vorhanden (erwartet ≥ ${REQUIRED_TABLES})."

  # Kritische Objekte einzeln prüfen (B2): agents/missions sind die Grundlage
  # jeder Pipeline. Fehlen sie, liefert /api/firm leere Arrays und der Runner
  # POSTet später missionId="null" → invalid input syntax for type uuid.
  local critical missing=() t
  for t in agents missions risk_config kill_switches positions equity_snapshots broker_credentials venue_control_state; do
    critical="$(psql "$DATABASE_URL" -tAc \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='${t}';" 2>/dev/null | tr -cd '0-9' || echo 0)"
    (( ${critical:-0} >= 1 )) || missing+=("$t")
  done
  if (( ${#missing[@]} > 0 )); then
    die "Kritische Tabellen fehlen: ${missing[*]}. Schema-Push wiederholen: DATABASE_URL=… npx drizzle-kit push --force"
  fi
  ok "Kritische Tabellen vorhanden (agents, missions, risk_config, kill_switches, positions, equity_snapshots, broker_credentials, venue_control_state)."
}

# ─────────────────────────────────────────────────────────────────────────────
# 10. Schritt 08 — Instrument-Universum (Markt-Presets)
# ─────────────────────────────────────────────────────────────────────────────
step_08_universe() {
  step "Instrument-Universum"

  # 1) Basis-Seed (26 Legacy-Instrumente) — hält den bestehenden Watchlist-Pfad grün.
  run npm run universe:seed \
    || die "universe:seed fehlgeschlagen. Datenverzeichnis beschreibbar? (data/universe)"

  # 2) Markt-Presets v1.30.0: 50 Aktien · 50 Indizes · 22 Rohstoffe · 30 Krypto.
  #    Das Skript ist idempotent (Upsert) und fail-loud bei abgelehnten Sätzen.
  local preset_json
  preset_json="$(npm run universe:seed:markets --silent -- --json 2>/dev/null || true)"
  if [[ -z "$preset_json" ]]; then
    die "universe:seed:markets lieferte kein Ergebnis. Manuell: npm run universe:seed:markets"
  fi

  local p_ok p_equity p_index p_commodity p_crypto p_rejected
  p_ok="$(jq -r '.ok' <<<"$preset_json")"
  p_equity="$(jq -r '.presets.equities' <<<"$preset_json")"
  p_index="$(jq -r '.presets.indices' <<<"$preset_json")"
  p_commodity="$(jq -r '.presets.commodities' <<<"$preset_json")"
  p_crypto="$(jq -r '.presets.crypto' <<<"$preset_json")"
  p_rejected="$(jq -r '.rejected | length' <<<"$preset_json")"

  if [[ "$p_ok" != "true" ]]; then
    jq -r '.rejected[] | "      abgelehnt \(.ref): \(.code) — \(.message)"' <<<"$preset_json" || true
    die "Preset-Seed unvollständig (${p_rejected} Sätze abgelehnt). Definition: src/universe/presets.ts"
  fi

  ok "Markt-Presets geschrieben: ${p_equity} Aktien · ${p_index} Indizes · ${p_commodity} Rohstoffe · ${p_crypto} Kryptowährungen."
  ok "Registry gesamt: $(jq -r '.registrySizeAfter' <<<"$preset_json") Instrumente."

  # Vertrag gegen die dokumentierten Zahlen prüfen — ein still dünneres
  # Universum wäre ein unsichtbarer Scanner-Fehler.
  (( p_equity == PRESET_EQUITIES ))       || die "Erwartet ${PRESET_EQUITIES} Aktien, Preset liefert ${p_equity}."
  (( p_index == PRESET_INDICES ))         || die "Erwartet ${PRESET_INDICES} Indizes, Preset liefert ${p_index}."
  (( p_commodity == PRESET_COMMODITIES )) || die "Erwartet ${PRESET_COMMODITIES} Rohstoffe, Preset liefert ${p_commodity}."
  (( p_crypto == PRESET_CRYPTO ))         || die "Erwartet ${PRESET_CRYPTO} Kryptowährungen, Preset liefert ${p_crypto}."

  # 3) Optional: Marktdaten-Warmup. Ohne ihn lehnt der Scanner alle Instrumente
  #    mit „min-candles" ab (MDSYNC-001) — deshalb ausdrücklich anbieten.
  if [[ "$DO_SYNC_MARKETS" == "true" ]]; then
    info "Marktdaten-Warmup (--sync-markets)…"
    if run_soft npm run market:sync -- --dry-run; then
      note "Dry-Run bestanden — echter Sync folgt. Ohne freigeschaltete Venue bleibt der Warmup leer."
      run_soft npm run market:sync
    else
      warn "Marktdaten-Dry-Run fehlgeschlagen — Warmup übersprungen (Registry ist trotzdem vollständig)."
    fi
    run_soft npm run market:sync:status \
      || note "Warmup-Readiness noch unvollständig: npm run market:sync -- --venue=<VENUE>"
  else
    note "Marktdaten-Warmup übersprungen. Nachholen: npm run market:sync -- --venue=BITUNIX"
    note "(ohne Warmup lehnt der Scanner alle Instrumente mit 'min-candles' ab)"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 11. Schritt 09 — Build
# ─────────────────────────────────────────────────────────────────────────────
step_09_build() {
  step "Anwendung bauen"

  if [[ "$DO_BUILD" != "true" ]]; then
    note "--skip-build: Build übersprungen."
    return 0
  fi

  local build_log build_status=0
  build_log="$(mktemp)"
  # Build-Ausgabe auswerten statt nur durchzureichen (B4): Turbopack-Warnungen
  # sind seit v1.30.0 behoben (src/lib/appPaths.ts) und dürfen nicht
  # unbemerkt zurückkommen.
  printf '    %s$ npm run build%s\n' "$C_BOLD" "$C_RESET"
  _log_to_file "RUN   npm run build"
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '    %s(dry-run: nicht ausgeführt)%s\n' "$C_DIM" "$C_RESET"
    rm -f "$build_log"
    return 0
  fi
  npm run build 2>&1 | tee "$build_log" | tee -a "${LOG_FILE:-/dev/null}" || true
  build_status="${PIPESTATUS[0]}"

  if (( build_status != 0 )); then
    tail -30 "$build_log" | sed 's/^/    /'
    rm -f "$build_log"
    die "next build fehlgeschlagen — Ausgabe oben, vollständiges Log: $LOG_FILE"
  fi

  local warnings
  warnings="$(grep -cE '^(Warning|⚠)' "$build_log" 2>/dev/null || true)"
  warnings="$(printf '%s' "${warnings:-0}" | tr -cd '0-9')"
  if (( ${warnings:-0} > 0 )); then
    warn "Build meldet ${warnings} Warnung(en):"
    grep -E '^(Warning|⚠|\.\/src)' "$build_log" | head -20 | sed 's/^/      /' || true
    warn "Behebung: Pfade über resolveRuntimePath()/joinRuntimePath() aus src/lib/appPaths.ts auflösen."
  else
    ok "Build warnungsfrei."
  fi
  rm -f "$build_log"
  ok "Build erfolgreich."
}

# ─────────────────────────────────────────────────────────────────────────────
# 12. Schritt 10 — Seed, Short-Default und 18-Check-Validierung
# ─────────────────────────────────────────────────────────────────────────────

# Räumt den temporären Validierungs-Server auf — auch bei Abbruch (trap).
VALIDATE_PID=""
cleanup_validate_server() {
  if [[ -n "$VALIDATE_PID" ]] && kill -0 "$VALIDATE_PID" 2>/dev/null; then
    note "Stoppe temporären Validierungs-Server (PID $VALIDATE_PID)…"
    kill "$VALIDATE_PID" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$VALIDATE_PID" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$VALIDATE_PID" 2>/dev/null || true
  fi
  VALIDATE_PID=""
}

# HTTP-Status einer URL (000 bei Verbindungsfehler).
http_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time "${1:-10}" "$2" 2>/dev/null || echo 000
}

step_10_validate() {
  step "Seed, Risiko-Defaults & Validierung"

  if [[ "$DO_VALIDATE" != "true" ]]; then
    note "--skip-validate: Validierung übersprungen."
    note "Nachholen: ./scripts/validate-setup.sh --base-url http://127.0.0.1:${APP_PORT}"
    return 0
  fi

  local base_url="http://127.0.0.1:${APP_PORT}"
  local started_here="false"

  # Läuft bereits eine Instanz? Dann nicht doppelt starten (Idempotenz).
  if [[ "$(http_code 5 "${base_url}/api/health")" == "200" ]]; then
    ok "Instanz läuft bereits auf ${base_url} — sie wird validiert."
  else
    if [[ "$DO_BUILD" != "true" ]]; then
      warn "Ohne Build kann kein Server gestartet werden — Validierung übersprungen."
      return 0
    fi
    info "Starte temporären Validierungs-Server auf ${base_url} (nur 127.0.0.1)…"
    # Bewusst auf 127.0.0.1 gebunden: die Validierung braucht keine LAN-Öffnung.
    ( cd "$PROJECT_ROOT" && PORT="$APP_PORT" npx next start -H 127.0.0.1 -p "$APP_PORT" ) \
      >>"$LOG_FILE" 2>&1 &
    VALIDATE_PID=$!
    started_here="true"
    trap 'cleanup_validate_server' EXIT

    local ready="false" _
    for _ in $(seq 1 60); do
      if [[ "$(http_code 3 "${base_url}/api/health")" == "200" ]]; then ready="true"; break; fi
      kill -0 "$VALIDATE_PID" 2>/dev/null || break
      sleep 1
    done
    if [[ "$ready" != "true" ]]; then
      warn "Temporärer Server wurde nicht bereit. Letzte Logzeilen:"
      tail -20 "$LOG_FILE" 2>/dev/null | sed 's/^/      /' || true
      cleanup_validate_server
      die "Validierung nicht möglich. Manuell: npm run start, dann ./scripts/validate-setup.sh"
    fi
    ok "Temporärer Server bereit (PID $VALIDATE_PID)."
  fi

  # ── Seed auslösen (idempotent) ───────────────────────────────────────────
  local auth=() seed_resp
  [[ -n "${API_TOKEN:-}" ]] && auth=(-H "x-firm-token: ${API_TOKEN}")
  info "Löse Seed aus (POST /api/seed — idempotent)…"
  seed_resp="$(curl -s --max-time 60 -X POST "${base_url}/api/seed" \
    ${auth[@]+"${auth[@]}"} 2>/dev/null || true)"
  if [[ "$(jq -r '.ok' <<<"$seed_resp" 2>/dev/null)" == "true" ]]; then
    ok "Seed abgeschlossen (agents/missions/risk_config/kill_switch)."
  else
    warn "Seed meldet: $(jq -c '.' <<<"$seed_resp" 2>/dev/null || printf '%s' "$seed_resp")"
    warn "Die Validierung läuft trotzdem — fehlende Stammdaten werden dort als Fehlcheck sichtbar."
  fi

  # ── Stammdaten direkt in der DB zählen (B2) ──────────────────────────────
  local n_agents n_missions bad_ids
  n_agents="$(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM agents;' 2>/dev/null | tr -cd '0-9' || echo 0)"
  n_missions="$(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM missions;' 2>/dev/null | tr -cd '0-9' || echo 0)"
  ok "Datenbank: ${n_agents} Agenten, ${n_missions} Missionen."
  (( ${n_agents:-0} >= 12 )) || warn "Erwartet ≥ 12 Agenten — Seed unvollständig?"
  (( ${n_missions:-0} >= 1 )) || warn "Keine Mission vorhanden — Pipeline-Läufe schlagen mit 'Mission nicht gefunden' fehl."

  # Mission-IDs auf UUID-Form prüfen (B2): der alte Smoke-Test POSTete bei
  # leerer Liste den String "null" → invalid input syntax for type uuid.
  bad_ids="$(psql "$DATABASE_URL" -tAc \
    "SELECT count(*) FROM missions WHERE id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\$';" \
    2>/dev/null | tr -cd '0-9' || echo 0)"
  if (( ${bad_ids:-0} > 0 )); then
    die "${bad_ids} Mission-IDs sind keine gültigen UUIDs — Datenbankbestand prüfen."
  fi
  ok "Alle Mission-IDs sind gültige UUIDs."

  # ── Short-Selling-Default (FEATURE v1.30.0) ──────────────────────────────
  # allowShort ist ein Runtime-Wert in risk_config (LIMIT_CEILINGS = [0,1]),
  # kein Code-Default. Upsert statt Insert: idempotent über mehrere Läufe.
  local short_value="1"
  [[ "$ALLOW_SHORTS" == "true" ]] || short_value="0"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO risk_config (key, value, description)
VALUES ('allowShort', '${short_value}', 'Short-Handel erlaubt? (0/1)')
ON CONFLICT (key) DO UPDATE SET value = '${short_value}', updated_at = now();
SQL
  if [[ "$ALLOW_SHORTS" == "true" ]]; then
    ok "Short-Selling per Default AKTIVIERT (risk_config.allowShort = 1)."
    note "Harte Grenzen bleiben: kein Hebel (maxLeverage 1), Stop-Loss-Pflicht, Kill-Switch."
  else
    ok "Short-Selling deaktiviert (risk_config.allowShort = 0)."
  fi

  # ── 18-Check-Validierung ─────────────────────────────────────────────────
  info "Validierung: 18 Checks (bestanden ab ${MIN_PASS})…"
  local validate_status=0
  if [[ "$DRY_RUN" == "true" ]]; then
    note "(dry-run) validate-setup.sh würde ausgeführt."
  else
    FIRM_API_TOKEN="${API_TOKEN:-}" EXPECT_SHORTS="$ALLOW_SHORTS" \
      "$SCRIPT_DIR/validate-setup.sh" \
        --base-url "$base_url" \
        --min-pass "$MIN_PASS" \
        --expect-shorts "$ALLOW_SHORTS" \
      || validate_status=$?
  fi

  if [[ "$started_here" == "true" ]]; then
    cleanup_validate_server
    trap - EXIT
  fi

  if (( validate_status != 0 )); then
    warn "Validierung unter ${MIN_PASS}/18 Checks — Details oben."
    warn "Behebung: docs/SETUP_BUGS.md und docs/INSTALL.md (Abschnitt Typische Fehler)."
    warn "Das Setup ist damit NICHT abgenommen. Erneut ausführen nach der Behebung."
    die "Validierung fehlgeschlagen."
  fi
  ok "Validierung bestanden."
}

# ─────────────────────────────────────────────────────────────────────────────
# 13. Ablauf & Abschluss
# ─────────────────────────────────────────────────────────────────────────────

print_banner() {
  printf '\n%s%s%s\n' "$C_BOLD" "Autonome KI-Trading-Firma — Installation (v1.30.0)" "$C_RESET"
  printf '  Variante:       %s  %s\n' "${VARIANT^^}" \
    "$( [[ $VARIANT == a ]] && echo '(Solo-Node)' || echo '(Split-Node)' )"
  printf '  Modellserver:   http://%s:11434\n' "$LLM_HOST"
  printf '  Datenbank:      %s@%s:%s/%s\n' "$DB_USER" "$DB_HOST" "$DB_PORT" "$DB_NAME"
  printf '  Cluster:        %s\n' "$PGDATA"
  printf '  App-Port:       %s\n' "$APP_PORT"
  printf '  Short-Selling:  %s\n' "$( [[ "$ALLOW_SHORTS" == "true" ]] && echo 'aktiviert (Default)' || echo 'deaktiviert' )"
  printf '  API-Token:      %s\n' "$( [[ -n "${API_TOKEN:-}" || "$GENERATE_API_TOKEN" == "true" ]] && echo 'wird gesetzt' || echo 'KEINER (offener Betrieb!)' )"
  printf '  Markt-Presets:  %d Aktien · %d Indizes · %d Rohstoffe · %d Krypto\n' \
    "$PRESET_EQUITIES" "$PRESET_INDICES" "$PRESET_COMMODITIES" "$PRESET_CRYPTO"
  printf '  Log:            %s\n' "${LOG_FILE:-<nur stdout>}"
  [[ "$DRY_RUN" == "true" ]] && printf '  %sMODUS: DRY-RUN — es wird nichts geändert%s\n' "$C_YELLOW" "$C_RESET"
  printf '\n'
}

print_summary() {
  cat <<EOF

${C_GREEN}${C_BOLD}Installation abgeschlossen.${C_RESET}

  Starten:          npm run start            → http://localhost:${APP_PORT}
  Als Dienst:       docs/INSTALL.md, Kapitel 7
  Validieren:       ./scripts/validate-setup.sh
  Funktionstest:    ./scripts/smoke-test.sh

  Markt-Universum:  ${PRESET_EQUITIES} Aktien · ${PRESET_INDICES} Indizes · ${PRESET_COMMODITIES} Rohstoffe · ${PRESET_CRYPTO} Kryptowährungen
  Short-Selling:    $( [[ "$ALLOW_SHORTS" == "true" ]] && echo "aktiviert (Default, jederzeit per /api/firm/config änderbar)" || echo "deaktiviert (--no-shorts)" )

  Nächste Schritte im Dashboard:
    1. Marktdaten-Warmup:  npm run market:sync -- --venue=BITUNIX
    2. Scan:               npm run scan -- --sync-first
    3. Danach:             docs/HANDBUCH.md, Kapitel 3

  Dokumentation:    docs/INSTALL.md · docs/SETUP_BUGS.md · docs/MARKET_UNIVERSE.md

EOF
}

main() {
  print_banner
  step_01_preflight
  step_02_packages
  step_03_postgres
  step_04_database
  step_05_env
  step_06_dependencies
  step_07_schema
  step_08_universe
  step_09_build
  step_10_validate
  print_summary
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
