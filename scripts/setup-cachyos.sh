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

# systemd-Helfer (Expansion von ${PGROOT} in ExecStart, Datadir-Auflösung).
# KORRIGIERT (v1.5.3): ohne Expansion meldete der Sicherheitsgurt fälschlich
#   „postgresql.service nutzt ein anderes Datenverzeichnis: '${PGROOT}/data'“.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pg-service.sh
source "$SCRIPT_DIR/lib/pg-service.sh"
# Cluster-Validierung (KORRIGIERT v1.5.4: Checks laufen als postgres-Benutzer,
# nicht als Aufrufer — sonst EACCES-Fehlalarm bei 0700-Verzeichnis).
# shellcheck source=lib/pg-cluster.sh
source "$SCRIPT_DIR/lib/pg-cluster.sh"

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

PGDATA="/var/lib/postgres/data"
PG_SVC="postgresql.service"

# KORRIGIERT (v1.5.4): Cluster-Prüfungen laufen als $PG_SUDO_USER (Standard:
# postgres) und NICHT als aufrufender Benutzer. initdb setzt Datenverzeichnis
# und /var/lib/postgres auf 0700 postgres:postgres — `test -f` des Aufrufers
# schlug mit EACCES fehl, obwohl der Cluster vollständig war ("Cluster nach
# initdb weiterhin unvollständig" bei erfolgreichem initdb).
PG_SUDO_USER="${PG_SUDO_USER:-postgres}"
ok "Cluster-Prüfungen laufen als Benutzer '$PG_SUDO_USER'."

# --- Preflight: sudo, Cluster-Benutzer, sudoers-Berechtigung ---
command -v sudo >/dev/null 2>&1 || die "sudo fehlt — installieren: sudo pacman -S sudo"
if ! id "$PG_SUDO_USER" >/dev/null 2>&1; then
  die "Benutzer '$PG_SUDO_USER' existiert nicht — postgresql-Paket prüfen (pacman -Q postgresql) und neu installieren."
fi
# Nicht-interaktiv "sudo -n true": Fehlercode ist normal, wenn ein Passwort
# verlangt wird (das Skript fragt dann interaktiv). Nur wenn sudo prinzipiell
# verweigert wird, gibt es eine klare Meldung.
if ! sudo -n true >/dev/null 2>&1; then
  sudo_err="$(sudo -n true 2>&1 || true)"
  if [[ "$sudo_err" == *"not in the sudoers"* || "$sudo_err" == *"not authorized"* \
        || "$sudo_err" == *"is not allowed to run sudo"* || "$sudo_err" == *"not in sudoers"* ]]; then
    die "Dein Benutzer darf kein sudo: usermod -aG wheel $USER, neu anmelden, dann /etc/sudoers prüfen."
  fi
fi

# Bezeichner hart validieren — sie landen als psql-Variablen (:\"var\") in SQL
# und dürfen deshalb nur aus sicheren Zeichen bestehen.
[[ "$DB_USER" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "Ungültiger DB-Benutzername: '$DB_USER' (erlaubt: a-z, 0-9, _, beginnt mit Buchstabe oder _)."
[[ "$DB_NAME" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]] || die "Ungültiger DB-Name: '$DB_NAME' (erlaubt: a-zA-Z, 0-9, _, beginnt mit Buchstabe oder _)."

# --- Server- und Cluster-Version ermitteln ---
PG_MAJOR="$(pg_server_major)"
if [[ -n "$PG_MAJOR" ]]; then
  ok "PostgreSQL-Server: $PG_MAJOR"
else
  warn "PostgreSQL-Version nicht ermittelbar (postgres/pg_config --version). Versionsabgleich wird übersprungen."
fi

# --- VERSIONS-ABGLEICH VOR JEDEM EINGRIFF (Datenschutz!) ---
# Ein Major-Mismatch heißt: alte Daten, neuer Server (oder umgekehrt). Das
# Skript initialisiert NIEMALS automatisch neu — das würde Daten zerstören.
if pg_version_mismatch "$PG_MAJOR" "$PGDATA"; then
  DATA_VERSION="$(pg_data_version "$PGDATA")"
  die "Cluster ist PostgreSQL $DATA_VERSION, installiert ist $PG_MAJOR — NICHT kompatibel (Major-Update). \
Kein automatisches initdb! Anleitung: docs/SETUP_PG_TROUBLESHOOTING.md, Abschnitt 4 (pg_upgrade / pg_dumpall)."
fi
CTRL_MAJOR="$(pg_control_major "$PGDATA")"
if [[ -n "$CTRL_MAJOR" && -n "$PG_MAJOR" && "$CTRL_MAJOR" != "$PG_MAJOR" ]]; then
  die "pg_control (Cluster $CTRL_MAJOR) passt nicht zum Server ($PG_MAJOR) — siehe docs/SETUP_PG_TROUBLESHOOTING.md, Abschnitt 4."
fi

# --- Dienst stoppen: WICHTIG vor Neuinitialisierung (Race gegen Auto-Restart) ---
pg_dienst_stoppen() {
  # 'activating' abfangen: systemd-Auto-Restart-Schleifen (Restart=on-failure)
  # laufen als ActiveState=activating, nicht als active.
  local state i
  state="$(systemctl show -p ActiveState --value "$PG_SVC" 2>/dev/null || true)"
  case "$state" in
    active|activating|reloading)
      run sudo systemctl stop "$PG_SVC" || true
      for i in $(seq 1 10); do
        state="$(systemctl show -p ActiveState --value "$PG_SVC" 2>/dev/null || true)"
        if [[ "$state" == "inactive" || "$state" == "failed" ]]; then
          break
        fi
        sleep 1
      done
      state="$(systemctl show -p ActiveState --value "$PG_SVC" 2>/dev/null || true)"
      if [[ "$state" == "active" || "$state" == "activating" ]]; then
        # KORRIGIERT (v1.5.4): Weiterlaufen wäre gefährlich — ein aktiver
        # Dienst kann direkt WÄHREND des nachfolgenden rm/initdb neu starten.
        warn "$PG_SVC stoppt nicht (State: $state) — letzte Logzeilen:"
        sudo journalctl -u "$PG_SVC" -n 15 --no-pager 2>/dev/null | sed 's/^/    /' || true
        die "Dienst stoppt nicht. Manuell: sudo systemctl stop $PG_SVC, dann erneut ausführen (docs/SETUP_PG_TROUBLESHOOTING.md, Abschnitt 5)."
      fi
      ;;
  esac
}

# --- Überbleibsel-Hygiene: veraltete postmaster.pid entfernen ---
# Rückgabe: 0 = ok (keine Datei oder entfernt); 1 = Prozess des Clusters LEBT
# noch → Aufrufer muss abbrechen (sonst Datenverlust bei rm/initdb!).
pg_cleanup_stale_pid() {
  local pid=""
  if ! pg_as_postgres test -f "$PGDATA/postmaster.pid"; then
    return 0
  fi
  pid="$(pg_as_postgres head -1 "$PGDATA/postmaster.pid" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    warn "Cluster läuft noch (postmaster.pid → PID $pid). Stoppen, sonst drohen Datenverlust/Konflikte:"
    warn "  sudo systemctl stop $PG_SVC"
    warn "  oder: sudo -u $PG_SUDO_USER pg_ctl -D $PGDATA stop"
    return 1
  fi
  warn "Veraltete postmaster.pid gefunden (Prozess $pid läuft nicht) — wird entfernt."
  pg_as_postgres rm -f "$PGDATA/postmaster.pid" || true
  return 0
}

# Sicherheitsgurt: Prüfen, ob der systemd-Dienst überhaupt in $PGDATA läuft.
# Bei einem Drop-in mit eigenem PGDATA würde sonst der falsche Cluster geprüft.
#
# KORRIGIERT (v1.5.3): systemd liefert Umgebungsvariablen in ExecStart
# UNEXPANDIERT — die Arch-Unit nutzt `-D ${PGROOT}/data`, `systemctl show`
# gibt genau diesen String zurück. Der alte Vergleich gegen `/var/lib/
# postgres/data` schlug deshalb fälschlich fehl. Jetzt wird die Unit-
# Environment eingesammelt und der Pfad expandiert, bevor verglichen wird.
SVC_PGDATA="$(pg_svc_datadir "$PG_SVC")"
if [[ -z "$SVC_PGDATA" ]]; then
  warn "Datenverzeichnis von $PG_SVC nicht ermittelbar — Sicherheitsgurt wird übersprungen."
elif [[ "$(pg_norm_path "$SVC_PGDATA")" != "$(pg_norm_path "$PGDATA")" ]]; then
  warn "postgresql.service nutzt ein anderes Datenverzeichnis: '$SVC_PGDATA'"
  die "Erwartet war '$PGDATA' (Arch-Standard). Drop-in klären (systemctl cat $PG_SVC), dann erneut ausführen."
else
  ok "$PG_SVC läuft im erwarteten Datenverzeichnis $PGDATA."
fi

# --- Cluster-Validierung (als $PG_SUDO_USER, versionstolerant) ---
if pg_cluster_ok "$PGDATA"; then
  ok "PostgreSQL-Cluster unter $PGDATA vollständig (Cluster-Version: $(pg_data_version "$PGDATA"))."
else
  # KORRIGIERT (v1.5.4): Diagnose läuft ebenfalls als Cluster-Benutzer.
  # Vorher meldete der Check bei 0700-Rechten fälschlich "existiert nicht
  # oder ist leer" bzw. "Cluster nach initdb weiterhin unvollständig".
  warn "Cluster-Check fehlgeschlagen — Diagnose:"
  pg_cluster_diagnostics "$PGDATA"

  # WICHTIG: Dienst zuerst stoppen. Ein aktiver/restartender postgresql.service
  # (Restart=on-failure) kann sonst genau WÄHREND initdb starten und einen halb
  # initialisierten Cluster als lauffähig ansehen — die Ursache des Originalfehlers.
  pg_dienst_stoppen
  if ! pg_cleanup_stale_pid; then
    die "Cluster-Instanz läuft noch — wie oben stoppen, dann erneut ausführen."
  fi
  # Doppelte Absicherung: pg_controldata darf keinen laufenden Cluster melden.
  PG_STATE="$(pg_control_state "$PGDATA")"
  if [[ "$PG_STATE" == *"running"* || "$PG_STATE" == *"in production"* ]]; then
    die "pg_controldata meldet: $PG_STATE. Cluster zuerst stoppen (sudo systemctl stop $PG_SVC bzw. sudo -u $PG_SUDO_USER pg_ctl -D $PGDATA stop)."
  fi

  if ask "Cluster neu initialisieren? (Vorhandene Daten in $PGDATA gehen verloren)"; then
    # Primärgruppe des Cluster-Benutzers (postgres → postgres; bei Tests/
    # Sonderfällen z. B. nobody → nogroup) statt starrem "-g postgres".
    PG_SUDO_GROUP="$(id -gn "$PG_SUDO_USER" 2>/dev/null || true)"
    [[ -n "$PG_SUDO_GROUP" ]] || PG_SUDO_GROUP="$PG_SUDO_USER"
    run sudo install -d -o "$PG_SUDO_USER" -g "$PG_SUDO_GROUP" "$(dirname "$PGDATA")"
    run sudo find "$PGDATA" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
    run sudo -u "$PG_SUDO_USER" mkdir -p "$PGDATA"
    # KORRIGIERT (v1.5.4): Locale-Fallback — C.UTF-8 ist auf Arch Standard,
    # aber falls ein System es nicht kennt, bricht initdb sonst ab.
    PG_LOCALE="C.UTF-8"
    if ! locale -a 2>/dev/null | grep -qi '^C\.UTF-8$' && ! locale -a 2>/dev/null | grep -qi '^C\.utf-8$'; then
      warn "Locale C.UTF-8 fehlt (locale -a) — initdb läuft mit 'C' statt C.UTF-8."
      PG_LOCALE="C"
    fi
    run sudo -u "$PG_SUDO_USER" initdb -D "$PGDATA" --locale="$PG_LOCALE" --encoding=UTF8 \
      --data-checksums --auth-local=peer --auth-host=scram-sha-256
  else
    die "Ohne vollständig initialisiertes Cluster geht es nicht weiter."
  fi
fi

# --- Nach-initdb-Verifikation: bei Fehler Diagnose + manueller Fahrplan ---
if ! pg_cluster_ok "$PGDATA"; then
  warn "Cluster nach initdb weiterhin unvollständig — Diagnose:"
  pg_cluster_diagnostics "$PGDATA"
  cat <<'RECOVER'

  Manuell prüfen (jede Zeile einzeln; NICHT als root ausführen!):

    sudo -u postgres ls -la /var/lib/postgres/data /var/lib/postgres/data/global
    sudo -u postgres pg_controldata -D /var/lib/postgres/data
    df -h /var/lib/postgres
    sudo journalctl -u postgresql -n 30 --no-pager

  Danach (Cluster ist bereits initialisiert — NICHT erneut löschen!):

    sudo systemctl start postgresql
    pg_isready                      # → "accepting connections"
    ./scripts/setup-cachyos.sh --variant a

  Ausführliche Anleitung: docs/SETUP_PG_TROUBLESHOOTING.md

RECOVER
  die "initdb hat keinen brauchbaren Cluster erzeugt. Siehe Anleitung oben."
fi

# --- Dienst starten — mit Port-/Fremdinstanz-Erkennung ---
pg_port_listener_pid() {
  local pid=""
  if command -v ss >/dev/null 2>&1; then
    pid="$(sudo ss -ltnp 'sport = :5432' 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)"
  fi
  if [[ -z "$pid" ]] && command -v fuser >/dev/null 2>&1; then
    pid="$(sudo fuser 5432/tcp 2>/dev/null | tr -s ' ' | head -1 || true)"
  fi
  printf '%s' "$pid"
}

if systemctl is-active --quiet "$PG_SVC"; then
  ok "$PG_SVC läuft bereits."
else
  PORT_PID="$(pg_port_listener_pid)"
  if [[ -n "$PORT_PID" ]]; then
    PORT_ARGS="$(ps -o args= -p "$PORT_PID" 2>/dev/null || true)"
    if [[ "$PORT_ARGS" == *"$PGDATA"* ]]; then
      warn "PostgreSQL läuft bereits auf Port 5432 (PID $PORT_PID), aber nicht unter systemd — vermutlich manuell via 'sudo -u postgres pg_ctl …' gestartet."
      warn "Das Skript nutzt diese Instanz weiter (gleiches Datenverzeichnis)."
    else
      die "Port 5432 ist durch einen fremden Prozess belegt (PID $PORT_PID): \
$(ps -o user=,args= -p "$PORT_PID" 2>/dev/null). Prüfen: sudo ss -ltnp 'sport = :5432' — Prozess stoppen und erneut ausführen."
    fi
  else
    # Port frei: alte Lock-Datei bereinigen (lebende Instanz ohne Port →
    # ungewöhnlich → Abbruch statt Datenverlust).
    if ! pg_cleanup_stale_pid; then
      die "Cluster-Instanz lebt, lauscht aber nicht auf Port 5432 — unklarer Zustand. Prozess prüfen (ps -p \$(head -1 $PGDATA/postmaster.pid)), stoppen, dann erneut ausführen."
    fi
    run sudo systemctl enable --now "$PG_SVC" || {
      warn "systemctl start fehlgeschlagen — letzte Logzeilen:"
      sudo journalctl -u "$PG_SVC" -n 20 --no-pager 2>/dev/null | sed 's/^/    /' || true
      die "Siehe docs/SETUP_PG_TROUBLESHOOTING.md (Schritte 1–6)."
    }
  fi
fi
info "Warte auf PostgreSQL-Bereitschaft (max. 30 s)…"
PG_READY=0
for _ in $(seq 1 30); do
  if pg_isready -q -t 1 || pg_isready -q -t 1 -h 127.0.0.1; then PG_READY=1; break; fi
  sleep 1
done
if (( ! PG_READY )); then
  warn "PostgreSQL nimmt nach 30 s keine Verbindungen an. Letzte Logzeilen:"
  sudo journalctl -u "$PG_SVC" -n 15 --no-pager 2>/dev/null | sed 's/^/      /' || true
  die "PostgreSQL nicht bereit. Logs oben prüfen, dann dieses Skript erneut ausführen — es erkennt und repariert halb initialisierte Cluster jetzt selbst."
fi
ok "PostgreSQL läuft und nimmt Verbindungen an."

# Harte SQL-Verifikation als Superuser, BEVOR Benutzer/Datenbank angelegt werden.
# (Vorher verschluckte ein if/grep den psql-Fehler und das Skript fragte munter
#  weiter Passwörter ab, obwohl gar kein Server erreichbar war.)
if ! sudo -u "$PG_SUDO_USER" psql -X -tAc "SELECT 1" &>/dev/null; then
  die "Superuser-Verbindung scheitert (sudo -u $PG_SUDO_USER psql). \
'journalctl -u $PG_SVC -n 50' prüfen; bei defektem Cluster dieses Skript erneut ausführen."
fi

if sudo -u "$PG_SUDO_USER" psql -X -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  ok "Benutzer '${DB_USER}' existiert bereits."
  read -r -s -p "  Passwort von '${DB_USER}' für die .env: " DB_PASS; echo
  # Auch hier nicht leer lassen: sonst entstünde eine DATABASE_URL ohne
  # Passwort und psql/pg scheiterten später mit kryptischem Fehler.
  [[ -n "$DB_PASS" ]] || die "Passwort für die .env darf nicht leer sein."
else
  read -r -s -p "  Neues Passwort für '${DB_USER}': " DB_PASS; echo
  [[ -n "$DB_PASS" ]] || die "Leeres Passwort ist keine gute Idee."
  # Injection-/Quote-sicher: Werte gehen als psql-Variablen rein, :\"var\"/
  # :'var' macht daraus korrekt maskierte Identifier bzw. Literale. Ein '
  # im Passwort bricht damit nichts mehr.
  sudo -u "$PG_SUDO_USER" psql -X -v ON_ERROR_STOP=1 \
    -v db_user="$DB_USER" -v db_name="$DB_NAME" -v db_pass="$DB_PASS" <<'SQL'
CREATE USER :"db_user" WITH PASSWORD :'db_pass';
CREATE DATABASE :"db_name" OWNER :"db_user";
GRANT ALL PRIVILEGES ON DATABASE :"db_name" TO :"db_user";
SQL
  ok "Benutzer und Datenbank angelegt."
fi

# KORRIGIERT (v1.5.3): Passwort URL-encoden, bevor es in die Connection-URI
# wandert. Zeichen wie @ : / % + & brechen sonst die DATABASE_URL in psql,
# node-postgres und drizzle-kit (SQL-Quoting allein reicht für URLs nicht).
# jq ist Pflichtpaket aus Schritt 1; Fallback bei fehlendem jq wäre ein
# unencodeter String — deshalb bricht das Skript unten lieber klar ab.
command -v jq >/dev/null || die "jq fehlt (Schritt 1 hat es installiert — bitte erneut ausführen)."
DB_PASS_ENC="$(jq -rn --arg v "$DB_PASS" '$v | @uri')"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS_ENC}@127.0.0.1:5432/${DB_NAME}"
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
    # KORRIGIERT (v1.5.3): Executor = Schlankstes Modell (deckt sich mit
    # .env.example; vorher wurde auch hier 3b verwendet).
    M_EXEC="qwen2.5:1.5b-instruct-q4_K_M"
  else
    M_BIG="qwen2.5:14b-instruct-q4_K_M"; M_SML="qwen2.5:7b-instruct-q4_K_M"
    M_COD="qwen2.5-coder:7b";            CTX=8192
    M_EXEC="qwen2.5:7b-instruct-q4_K_M"
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
MODEL_EXECUTOR=${M_EXEC}
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
# KORRIGIERT (v1.1.0): erwartet 9 Tabellen — equity_snapshots fehlte im Check.
TABLES=""
for attempt in 1 2 3; do
  sleep 1
  TABLES="$(psql "$DATABASE_URL" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo 0)"
  (( TABLES >= 9 )) && break
  warn "Versuch ${attempt}/3: Tabellen noch nicht vollständig (${TABLES} vorhanden)…"
done
(( TABLES >= 9 )) || die \
  "Nur ${TABLES} Tabellen angelegt (erwartet: 9). Prüfe DATABASE_URL in .env.\n" \
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

  Starten:        npm run start        → http://localhost:3369
  Prüfen:         ./scripts/smoke-test.sh
  Als Dienst:     docs/INSTALL.md, Kapitel 7
$([[ "$VARIANT" == b ]] && echo "  RX 480 nutzen:  docs/INSTALL.md, Kapitel 8.3 (Vulkan)")

  Im Dashboard zuerst "Seed / Reset", danach "▶▶ Ganze Pipeline".
  Danach weiter im Handbuch: docs/HANDBUCH.md, Kapitel 3.

EOF
