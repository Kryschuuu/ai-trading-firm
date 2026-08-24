#!/usr/bin/env bash
#
# Geführte Installation der autonomen KI-Trading-Firma auf CachyOS / Arch.
#
#   ./scripts/setup-cachyos.sh --variant a
#   ./scripts/setup-cachyos.sh --variant b --llm-host 192.168.1.50
#
# Das Skript ist absichtlich gesprächig: es zeigt jeden Systembefehl an und fragt
# nach, bevor es etwas ändert. Lies mit, statt blind zu bestätigen.
#
set -euo pipefail

VARIANT=""
LLM_HOST="127.0.0.1"
DB_NAME="trading_firm"
DB_USER="trader"
DB_PASS=""

C_RESET=$'\e[0m'; C_BOLD=$'\e[1m'; C_GREEN=$'\e[32m'
C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_CYAN=$'\e[36m'

info()  { echo "${C_CYAN}==>${C_RESET} $*"; }
ok()    { echo "${C_GREEN}  ✓${C_RESET} $*"; }
warn()  { echo "${C_YELLOW}  !${C_RESET} $*"; }
die()   { echo "${C_RED}  ✗ $*${C_RESET}" >&2; exit 1; }

ask() {
  local prompt="$1"
  read -r -p "${C_BOLD}${prompt}${C_RESET} [j/N] " answer
  [[ "$answer" =~ ^([jJ]|[yY])$ ]]
}

run() {
  echo "    ${C_BOLD}\$ $*${C_RESET}"
  "$@"
}

usage() {
  cat <<'EOF'
Verwendung:
  ./scripts/setup-cachyos.sh --variant a
  ./scripts/setup-cachyos.sh --variant b --llm-host <IP-des-Desktops>

Optionen:
  --variant a|b     a = Solo-Node (alles auf dem N150)
                    b = Split-Node (Modelle laufen auf einem anderen Rechner)
  --llm-host IP     IP-Adresse des Modellservers (nur Variante B)
  --db-name NAME    Datenbankname   (Standard: trading_firm)
  --db-user USER    Datenbankbenutzer (Standard: trader)
  -h, --help        diese Hilfe
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant)  VARIANT="${2,,}"; shift 2 ;;
    --llm-host) LLM_HOST="$2";    shift 2 ;;
    --db-name)  DB_NAME="$2";     shift 2 ;;
    --db-user)  DB_USER="$2";     shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *) die "Unbekannte Option: $1  (--help für Hilfe)" ;;
  esac
done

[[ "$VARIANT" == "a" || "$VARIANT" == "b" ]] || { usage; die "--variant a oder b angeben"; }
[[ "$VARIANT" == "b" && "$LLM_HOST" == "127.0.0.1" ]] && \
  warn "Variante B ohne --llm-host: es wird localhost verwendet."

echo
echo "${C_BOLD}Autonome KI-Trading-Firma — Installation${C_RESET}"
echo "  Variante:      ${VARIANT^^}  $([[ $VARIANT == a ]] && echo '(Solo-Node)' || echo '(Split-Node)')"
echo "  Modellserver:  http://${LLM_HOST}:11434"
echo "  Datenbank:     ${DB_NAME} / Benutzer ${DB_USER}"
echo

# ---------------------------------------------------------------- 1. Pakete
info "Schritt 1/6 — Systempakete"
MISSING=()
for pkg in nodejs npm postgresql git jq; do
  pacman -Qi "$pkg" &>/dev/null || MISSING+=("$pkg")
done
if ((${#MISSING[@]})); then
  warn "Es fehlen: ${MISSING[*]}"
  if ask "Jetzt mit pacman installieren?"; then
    run sudo pacman -S --needed "${MISSING[@]}"
  else
    die "Ohne diese Pakete geht es nicht weiter."
  fi
else
  ok "Alle Systempakete vorhanden."
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
(( NODE_MAJOR >= 20 )) || die "Node.js 20+ nötig, gefunden: $(node --version 2>/dev/null || echo 'keins')"
ok "Node.js $(node --version)"

# ------------------------------------------------------------ 2. PostgreSQL
info "Schritt 2/6 — PostgreSQL"
if [[ ! -d /var/lib/postgres/data/base ]]; then
  warn "Datenverzeichnis ist nicht initialisiert."
  if ask "Jetzt initdb ausführen?"; then
    run sudo -u postgres initdb -D /var/lib/postgres/data --locale=C.UTF-8 --encoding=UTF8
  else
    die "Ohne initialisierte Datenbank geht es nicht weiter."
  fi
fi

systemctl is-active --quiet postgresql || run sudo systemctl enable --now postgresql
sleep 1
systemctl is-active --quiet postgresql || die "PostgreSQL startet nicht — 'journalctl -u postgresql' prüfen."
ok "PostgreSQL läuft."

if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  ok "Benutzer '${DB_USER}' existiert bereits."
  read -r -s -p "  Passwort von '${DB_USER}' für die .env: " DB_PASS; echo
else
  read -r -s -p "  Neues Passwort für '${DB_USER}': " DB_PASS; echo
  [[ -n "$DB_PASS" ]] || die "Leeres Passwort ist keine gute Idee."
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';
CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL
  ok "Benutzer und Datenbank angelegt."
fi

DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}"
psql "$DATABASE_URL" -c "SELECT 1;" &>/dev/null || die "Verbindung zur Datenbank schlägt fehl."
ok "Datenbankverbindung steht."

# ---------------------------------------------------------------- 3. Modelle
info "Schritt 3/6 — Modellserver"
if curl -s --max-time 3 "http://${LLM_HOST}:11434/api/tags" >/dev/null 2>&1; then
  COUNT="$(curl -s "http://${LLM_HOST}:11434/api/tags" | jq '.models | length')"
  ok "Ollama erreichbar auf ${LLM_HOST} (${COUNT} Modelle)."

  if [[ "$VARIANT" == "a" ]]; then
    MODEL="qwen2.5:3b-instruct-q4_K_M"
  else
    MODEL="qwen2.5:7b-instruct-q4_K_M"
  fi

  if curl -s "http://${LLM_HOST}:11434/api/tags" | jq -e --arg m "${MODEL%%:*}" \
       '.models[] | select(.name | startswith($m))' >/dev/null; then
    ok "Passendes Modell bereits vorhanden."
  else
    warn "Empfohlenes Modell für Variante ${VARIANT^^}: ${MODEL}"
    if [[ "$LLM_HOST" == "127.0.0.1" ]] && ask "Jetzt herunterladen (mehrere GB)?"; then
      run ollama pull "$MODEL"
    else
      warn "Bitte auf dem Modellrechner ausführen:  ollama pull ${MODEL}"
    fi
  fi
else
  warn "Ollama auf ${LLM_HOST}:11434 nicht erreichbar."
  warn "Das System startet trotzdem und nutzt dann die deterministische Regel-Engine."
  [[ "$VARIANT" == "b" ]] && warn "Variante B: docs/INSTALL.md Kapitel 8.1 (LAN-Freigabe) prüfen."
fi

# ------------------------------------------------------------------ 4. .env
info "Schritt 4/6 — Konfiguration (.env)"
if [[ -f .env ]] && ! ask "Vorhandene .env überschreiben?"; then
  ok "Bestehende .env bleibt unverändert."
else
  if [[ "$VARIANT" == "a" ]]; then
    M_BIG="qwen2.5:3b-instruct-q4_K_M"; M_SML="qwen2.5:3b-instruct-q4_K_M"
    M_COD="qwen2.5:3b-instruct-q4_K_M"; CTX=4096
  else
    M_BIG="qwen2.5:14b-instruct-q4_K_M"; M_SML="qwen2.5:7b-instruct-q4_K_M"
    M_COD="qwen2.5-coder:7b";            CTX=8192
  fi

  cat > .env <<ENV
# Erzeugt von scripts/setup-cachyos.sh — Variante ${VARIANT^^}
DATABASE_URL=${DATABASE_URL}

LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://${LLM_HOST}:11434
OLLAMA_NUM_CTX=${CTX}
LLM_TIMEOUT_MS=180000

STARTING_EQUITY=10000
REQUIRE_HUMAN_APPROVAL=false

MODEL_CEO=${M_BIG}
MODEL_RESEARCH=${M_SML}
MODEL_BACKTEST=${M_COD}
MODEL_RISK=${M_SML}
MODEL_APPROVER=${M_SML}
MODEL_EXECUTOR=${M_SML}
ENV
  chmod 600 .env
  ok ".env geschrieben (Rechte 600)."
fi

# -------------------------------------------------------- 5. Abhängigkeiten
info "Schritt 5/6 — Abhängigkeiten und Datenbankschema"
run npm install

# ---- Workaround: Schema-Push auf die richtige Datenbank sicherstellen ----
#
# Problem (tritt bei Variante B und bei frischen Installationen auf):
#   Frühere Versionen nutzten drizzle.config.json mit einer hardcodierten URL
#   (postgresql://postgres:postgres@127.0.0.1:5432/app_db). Auf dem N150 mit
#   anderer DB-Konfiguration zeigte der Push auf die falsche Datenbank — die
#   Tabellen wurden dort angelegt, nicht in der echten trading_firm-DB.
#   Ergebnis: "relation 'positions' does not exist" beim ersten Start.
#
# Lösung: Das Projekt nutzt jetzt drizzle.config.ts, das DATABASE_URL aus .env
#   liest. Als Absicherung übergeben wir die URL zusätzlich explizit über die
#   Umgebungsvariable, damit auch ein etwaiges altes .json-File keine Chance hat.
#
echo "    ${C_BOLD}\$ DATABASE_URL=${DATABASE_URL} npx drizzle-kit push --force${C_RESET}"
DATABASE_URL="${DATABASE_URL}" npx drizzle-kit push --force

# Verifizieren (mit Retry, weil PostgreSQL kurz brauchen kann)
TABLES=""
for attempt in 1 2 3; do
  sleep 1
  TABLES="$(psql "$DATABASE_URL" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo 0)"
  (( TABLES >= 7 )) && break
  warn "Versuch ${attempt}/3: Tabellen noch nicht vollständig (${TABLES} vorhanden)…"
done
(( TABLES >= 7 )) || die \
  "Nur ${TABLES} Tabellen angelegt (erwartet: 8). Prüfe DATABASE_URL in .env.\n" \
  "  Mögliche Ursache: PostgreSQL läuft nicht, falsches Passwort, oder Netzwerk.\n" \
  "  Debug: psql \"${DATABASE_URL}\" -c '\\dt'"

ok "${TABLES} Tabellen vorhanden."

# stop_loss-Spalte explizit prüfen (war in älteren Versionen nicht im Schema)
STOPLOSS_COL="$(psql "$DATABASE_URL" -tAc \
  "SELECT count(*) FROM information_schema.columns
   WHERE table_name='positions' AND column_name='stop_loss';" 2>/dev/null || echo 0)"
if (( STOPLOSS_COL < 1 )); then
  warn "Spalte 'stop_loss' fehlt in 'positions' — Schema veraltet."
  warn "Führe nochmals 'npx drizzle-kit push --force' aus."
  DATABASE_URL="${DATABASE_URL}" npx drizzle-kit push --force
  ok "Schema erneut angewendet."
else
  ok "Spalte 'stop_loss' vorhanden."
fi

# ------------------------------------------------------------------ 6. Build
info "Schritt 6/6 — Anwendung bauen"
run npm run build
ok "Build erfolgreich."

cat <<EOF

${C_GREEN}${C_BOLD}Fertig.${C_RESET}

  Starten:        npm run start        → http://localhost:3000
  Prüfen:         ./scripts/smoke-test.sh
  Als Dienst:     docs/INSTALL.md, Kapitel 7
$([[ "$VARIANT" == b ]] && echo "  RX 480 nutzen:  docs/INSTALL.md, Kapitel 8.3 (Vulkan)")

  Im Dashboard zuerst "Seed / Reset", danach "▶▶ Ganze Pipeline".
  Danach weiter im Handbuch: docs/HANDBUCH.md, Kapitel 3.

EOF
