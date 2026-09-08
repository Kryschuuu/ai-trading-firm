#!/usr/bin/env bash
#
# Sauberes Herunterfahren des Next.js-Servers.
#
# Spiegelt das Verhalten der systemd-Unit (deploy/ai-trading-firm.service):
#   KillSignal=SIGTERM, TimeoutStopSec=30
#   1) SIGTERM schicken, damit offene DB-Verbindungen / Transaktionen
#      sauber abschließen können,
#   2) bis zu $STOP_TIMEOUT Sekunden warten,
#   3) notfalls SIGKILL erzwingen.
#
# Port über Umgebungsvariable wählbar:
#   PORT=4000 npm run stop
#
# Hinweis: Das ist der Server-Stop, NICHT der Trading-Kill-Switch
# (/api/firm/kill). Ein laufender Server wird hier beendet, die Firma
# läuft danach natürlich nicht mehr.

set -uo pipefail

PORT="${PORT:-3369}"
STOP_TIMEOUT="${STOP_TIMEOUT:-30}"

# STOP-01 (v1.30.1): Nicht-numerische Timeouts ließen `seq` fehlschlagen —
# die Warteschleife entfiel dann still und der Server bekam sofort SIGKILL.
if [[ ! "$STOP_TIMEOUT" =~ ^[0-9]+$ ]] || (( STOP_TIMEOUT < 1 || STOP_TIMEOUT > 300 )); then
  echo "Warnung: Ungültiges STOP_TIMEOUT='$STOP_TIMEOUT' — verwende 30 s." >&2
  STOP_TIMEOUT=30
fi

# PID über den lauschenden Port ermitteln (bevorzugt).
pid_from_port() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$PORT" 2>/dev/null
  elif command -v fuser >/dev/null 2>&1; then
    fuser "${PORT}/tcp" 2>/dev/null | tr -d ' '
  fi
}

PIDS="$(pid_from_port)"

# Fallback: Next.js-Prozesse direkt ansprechen (dev + start).
# STOP-03 (v1.30.1): Verankerte Muster — Tokens statt Substrings. Echte
# Server zeigen argv[0]=next-server (`next start`, dahinter Leerzeichen) bzw.
# ein Token wie `npx next start` / `.../next dev` in der Zeile. Reine
# Substrings (`less next-server.log`, `vim my-next-server.md`) treffen nicht.
if [[ -z "$PIDS" ]]; then
  PIDS="$(pgrep -f '(^|[/ ])next +(start|dev)|(^|[ /])next-server( |$)' 2>/dev/null)"
fi

# Eigene Ahnenkette (stop.sh selbst eingeschlossen), per Leerzeichen getrennt.
# Schützt die aufrufende Kette, egal was in deren Kommandozeilen steht — etwa
# wenn der Aufrufbefehl selbst „next-server“ enthält. Ohne `ps` fällt die
# Kette auf die eigene PID zurück (besser als nichts).
stop_self_chain() {
  local chain=" $$ " p="$$" pps ppid
  while pps="$(ps -o ppid= -p "$p" 2>/dev/null)" && [[ -n "${pps//[[:space:]]/}" ]]; do
    ppid="$(printf '%s' "$pps" | tr -d '[:space:]')"
    [[ -z "$ppid" || "$ppid" == "0" || "$chain" == *" $ppid "* ]] && break
    chain+="$ppid "
    p="$ppid"
  done
  printf '%s' "$chain"
}

# STOP-02 (v1.30.1): Selbstschutz — keine PID der eigenen Ahnenkette bekommt
# je ein Signal, selbst wenn ihr Befehl auf die Muster passt.
if [[ -n "$PIDS" ]]; then
  SELF_CHAIN="$(stop_self_chain)"
  FILTERED=""
  # shellcheck disable=SC2086 — bewusste Wortspaltung (PIDs sind Leerzeichen-/Zeilen-getrennt)
  for p in $PIDS; do
    [[ "$SELF_CHAIN" == *" $p "* ]] || FILTERED+="$p "
  done
  PIDS="$(printf '%s' "$FILTERED" | tr -s ' ' | sed 's/^ //;s/ $//')"
fi

if [[ -z "$PIDS" ]]; then
  echo "Kein laufender Next.js-Server auf Port $PORT gefunden."
  exit 0
fi

echo "Beende Next.js-Server (PID: ${PIDS}) via SIGTERM …"
# shellcheck disable=SC2086
kill -TERM $PIDS 2>/dev/null || true

for i in $(seq 1 "$STOP_TIMEOUT"); do
  alive=0
  for p in $PIDS; do
    if kill -0 "$p" 2>/dev/null; then alive=1; break; fi
  done
  if [[ $alive -eq 0 ]]; then
    echo "Server nach ${i}s sauber gestoppt."
    exit 0
  fi
  sleep 1
done

echo "Server reagiert nicht auf SIGTERM — erzwinge SIGKILL."
# shellcheck disable=SC2086
kill -KILL $PIDS 2>/dev/null || true
exit 0
