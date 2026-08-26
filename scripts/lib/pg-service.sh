#!/usr/bin/env bash
#
# systemd-/PostgreSQL-Helfer für scripts/setup-cachyos.sh
#
# PROBLEM (v1.5.3 — Originalfehler des Nutzers):
#   `systemctl show -p ExecStart --value postgresql.service` liefert das
#   ExecStart-Argument UNEXPANDIERT. Die Arch-Unit definiert:
#       Environment=PGROOT=/var/lib/postgres
#       ExecStart=/usr/bin/postgres -D ${PGROOT}/data
#   Der Aufruf liefert also literal `${PGROOT}/data` — und der Vergleich gegen
#   den erwarteten Pfad /var/lib/postgres/data schlug fälschlich fehl:
#       ! postgresql.service nutzt ein anderes Datenverzeichnis: '${PGROOT}/data'
#
# LÖSUNG:
#   1. Environment-Werte der Unit einsammeln (systemctl show -p Environment —
#      enthält auch EnvironmentFile- und Drop-in-Werte, letzte Definition gewinnt).
#   2. ${VAR}/$VAR im -D-Pfad expandieren, erst DANN vergleichen.
#   3. Auch die beiden anderen systemd-Ausgabeformen verarbeiten:
#      - gequotete argv-Tokens (systemd 253+: -D "/pfad")
#      - Struktur-Liste  { path=… ; argv[]=… ; … }  (ohne --value)
#   4. Fallback auf `systemctl cat` (Haupt-Unit + Drop-ins, letzte Definition
#      gewinnt), falls `systemctl show` nichts liefert (z. B. kein Bus).
#
# Alle Funktionen sind pur und werden in tests/setupPgService.test.ts gegen
# eine gemockte `systemctl`-Binary getestet (Regressionstest für den
# ${PGROOT}-Vorfall).
#
set -o pipefail

# Environment der Unit: KEY → WERT (global, von pg_svc_load_env gefüllt).
declare -gA PG_SVC_ENV=()

# Liest alle Environment=KEY=VALUE-Einträge der Unit (inkl. Drop-ins).
# Bevorzugt die von systemd aufgelöste Umgebung; schlägt `systemctl show`
# fehl (kein Bus), werden die Environment=-Zeilen aus `systemctl cat`
# geparst (Haupt-Unit zuerst, Drop-ins danach → letzte Definition gewinnt).
pg_svc_load_env() {
  local svc="$1" line key val token
  PG_SVC_ENV=()
  # systemctl show -p Environment --value liefert String-Listen ggf.
  # LEERZEICHEN-getrennt auf einer Zeile ("KEY=VAL KEY2=VAL2") — deshalb
  # Token für Token parsen. read || [[ -n $line ]]: auch letzte Zeile ohne \n.
  # ACHTUNG set -e: Schleifen-/Bedingungsenden müssen Status 0 liefern —
  # `[[ … ]] && …` als letztes Kommando würde bei verfehlter Prüfung in
  # aufrufendem Skript (set -euo pipefail) den Abbruch auslösen.
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ -z "$line" ]]; then continue; fi
    # shellcheck disable=SC2086 — bewusste Wortspaltung über IFS
    for token in $line; do
      [[ "$token" == *=* ]] || continue
      key="${token%%=*}"
      val="${token#*=}"
      if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        PG_SVC_ENV["$key"]="$val"
      fi
    done
  done < <(systemctl show -p Environment --value "$svc" 2>/dev/null || true)
  if (( ${#PG_SVC_ENV[@]} == 0 )); then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ -z "$line" ]]; then continue; fi
      # Eventuelle Umgebungs-Quotes entfernen: Environment="K=V"
      line="${line#\"}"
      line="${line%\"}"
      key="${line%%=*}"
      val="${line#*=}"
      if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        PG_SVC_ENV["$key"]="$val"
      fi
    done < <(systemctl cat "$svc" 2>/dev/null \
      | sed -n 's/^[[:space:]]*Environment=//p' || true)
  fi
}

# Expandiert ${VAR} und $VAR anhand der Unit-Environment (max. 32 Runden).
pg_svc_expand_vars() {
  local s="$1" key val guard=0
  while ((guard++ < 32)); do
    if [[ "$s" =~ \$\{([A-Za-z_][A-Za-z0-9_]*)\} ]]; then
      key="${BASH_REMATCH[1]}"
      val="${PG_SVC_ENV[$key]:-}"
      s="${s//\$\{${key}\}/${val}}"
    elif [[ "$s" =~ \$([A-Za-z_][A-Za-z0-9_]*) ]]; then
      key="${BASH_REMATCH[1]}"
      val="${PG_SVC_ENV[$key]:-}"
      s="${s//\$${key}/${val}}"
    else
      break
    fi
  done
  printf '%s' "$s"
}

# Extrahiert das Argument hinter `-D` aus einer ExecStart-Zeile.
# Robust gegen: ungequotete Pfade, "gequotete" Pfade, 'einfach-quotierte'
# Pfade und systemd-argv-Struktur { path=… ; argv[]=… ; … }.
pg_svc_extract_exec_d() {
  local s="$1" m="" dq='"' sq="'"
  if [[ "$s" == *"argv[]="* ]]; then
    s="${s#*argv[]=}"
    s="${s%%;*}"
  fi
  # Anführungszeichen über Variablen in die Regex einspeisen: ein nacktes
  # ' oder " im [[ =~ ]]-Ausdruck bricht sonst die Bash-Quoting-Syntax.
  if [[ "$s" =~ -D[[:space:]]+${dq}([^${dq}]+)${dq} ]]; then
    m="${BASH_REMATCH[1]}"
  elif [[ "$s" =~ -D[[:space:]]+${sq}([^${sq}]+)${sq} ]]; then
    m="${BASH_REMATCH[1]}"
  elif [[ "$s" =~ -D[[:space:]]+([^[:space:]${dq}${sq}]+) ]]; then
    m="${BASH_REMATCH[1]}"
  fi
  # Reste der argv-Liste abstreifen (';' ')' '}' ',' Anführungszeichen am Ende).
  # Bewusst case-Patterns statt [[ =~ ]]: ein ' im Regex bräche das Quoting.
  while :; do
    case "$m" in
      *';'|*')'|*'}'|*'"'|*"'"|*',') m="${m:0:${#m}-1}" ;;
      *) break ;;
    esac
  done
  printf '%s' "$m"
}

# ExecStart-Zeile: bevorzugt `systemctl show`, sonst `systemctl cat`.
pg_svc_execstart() {
  local svc="$1" exec_str=""
  exec_str="$(systemctl show -p ExecStart --value "$svc" 2>/dev/null || true)"
  if [[ -z "$exec_str" ]]; then
    # Fallback: systemctl cat — Reihenfolge Haupt-Unit → Drop-ins, die letzte
    # ExecStart=Definition gewinnt (systemd-Semantik).
    exec_str="$(systemctl cat "$svc" 2>/dev/null \
      | sed -n 's/^[[:space:]]*ExecStart=//p' | tail -1 || true)"
  fi
  printf '%s' "$exec_str"
}

# Tatsächliches (expandiertes) -D-Datenverzeichnis der Unit; leer bei Fehler.
# Gibt IMMER mit Status 0 zurück (set -e-freundlich): keine `&& return`-
# Kurzschlüsse, die unter set -e den Aufrufer abbrechen würden.
pg_svc_datadir() {
  local svc="$1" exec_str d
  pg_svc_load_env "$svc"
  exec_str="$(pg_svc_execstart "$svc")"
  if [[ -z "$exec_str" ]]; then
    printf ''
    return 0
  fi
  d="$(pg_svc_extract_exec_d "$exec_str")"
  if [[ -z "$d" ]]; then
    printf ''
    return 0
  fi
  d="$(pg_svc_expand_vars "$d")"
  printf '%s' "$d"
  return 0
}

# Lexikalische Pfadnormalisierung (//, trailing /) für den Vergleich.
pg_norm_path() {
  local p="${1:-}"
  if [[ -z "$p" ]]; then
    printf ''
    return 0
  fi
  readlink -m "$p" 2>/dev/null || printf '%s' "$p"
}
