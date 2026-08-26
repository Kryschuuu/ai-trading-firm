#!/usr/bin/env bash
#
# Cluster-Validierung für scripts/setup-cachyos.sh — v1.5.4
#
# PROBLEM (v1.5.4 — Vorfall Nr. 2 des Nutzers):
#   initdb lief mit "Erfolg" durch, trotzdem meldete das Skript:
#       ✗ Cluster nach initdb weiterhin unvollständig (PG_VERSION/global/*)
#   Ursache: `initdb` setzt das Datenverzeichnis auf 0700 postgres:postgres
#   (ebenso /var/lib/postgres). Alle `test -f`-Checks liefen aber als der
#   AUFRUFENDE Benutzer → EACCES → der Check war falsch negativ. Das Skript
#   hielt einen VOLLSTÄNDIGEN Cluster für defekt und bot die datenzerstörende
#   Neuinitialisierung an. (Gleiche Ursache für die irreführende Meldung
#   „Datenverzeichnis existiert nicht oder ist leer“ davor.)
#
# LÖSUNG:
#   1. Jede Prüfung am Datenverzeichnis läuft als Cluster-Benutzer
#      (sudo -u postgres) — Nicht-lesbare-Verzeichnisse sind damit kein
#      Fehlalarm mehr.
#   2. Relmap-Marker versionstolerant: PG ≤ 18 nutzt global/pg_filenode.map
#      (RELMAPPER_FILENAME im Source, auch REL_18_STABLE). Für unbekannte/
#      künftige Major-Versionen wird der Marker nur noch geprüft, wenn der
#      Cluster selbst ihn verlangt (PG_VERSION-File), sonst Warnung.
#   3. Versionsabgleich Cluster ↔ Server (PG_VERSION + pg_controldata):
#      bei Major-Mismatch wird NICHT automatisch neuinitialisiert, sondern
#      mit pg_upgrade-/Dump-Anleitung abgebrochen (Daten schützen!).
#   4. pg_controldata-Validierung statt bloßem Datei-Raten.
#
# Alle Funktionen sind set -e- und set -o pipefail-sicher (keine
# &&-Kurzschlüsse als letztes Kommando), damit das aufrufende Skript nie
# mitten im Check stirbt.
#
set -o pipefail

# Cluster-Benutzer. Wird LAUFZEIT aus der Umgebung gelesen (nicht beim
# Source), damit das Setup-Skript PG_SUDO_USER vor dem ersten Aufruf setzen
# und Tests den User umbiegen können (z. B. nobody).
PG_SUDO_USER="${PG_SUDO_USER:-postgres}"

# Führt ein Kommando als $PG_SUDO_USER aus. Root und der Benutzer selbst
# brauchen kein sudo. Fehlendes sudo → Status 1 (Aufrufer bricht sauber ab).
pg_as_postgres() {
  local u="${PG_SUDO_USER:-postgres}"
  if [[ "$(id -u 2>/dev/null)" == "0" ]]; then
    "$@"
  elif [[ "$(id -un 2>/dev/null)" == "$u" ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "$u" -- "$@"
  else
    return 1
  fi
}

# Major-Version des installierten Servers (postgres --version / pg_config).
# Leer, wenn nicht ermittelbar (dann laufen Checks ohne Versionsabgleich).
pg_server_major() {
  local v=""
  v="$(postgres --version 2>/dev/null | sed -nE 's/^postgres \(PostgreSQL\) ([0-9]+)\..*/\1/p')"
  if [[ "$v" =~ ^[0-9]+$ ]]; then
    printf '%s' "$v"
    return 0
  fi
  v="$(pg_config --version 2>/dev/null | sed -nE 's/PostgreSQL ([0-9]+)\..*/\1/p')"
  if [[ "$v" =~ ^[0-9]+$ ]]; then
    printf '%s' "$v"
  fi
  return 0
}

# Major-Version des CLUSTERS aus $PGDATA/PG_VERSION (als Cluster-Benutzer).
# Leer, wenn kein Cluster oder nicht lesbar.
pg_data_version() {
  local data="$1" v=""
  if [[ -z "$data" ]]; then
    printf ''
    return 0
  fi
  v="$(pg_as_postgres cat "$data/PG_VERSION" 2>/dev/null | tr -cd '0-9')"
  if [[ "$v" =~ ^[0-9]+$ ]]; then
    printf '%s' "$v"
  fi
  return 0
}

# Grundgerüst eines initialisierten Clusters: PG_VERSION, global/pg_control,
# base/-Verzeichnis. Alle Prüfungen als Cluster-Benutzer → kein EACCES-Fehlalarm.
pg_cluster_basic_ok() {
  local data="$1"
  if [[ -z "$data" ]]; then
    return 1
  fi
  if pg_as_postgres test -f "$data/PG_VERSION" \
    && pg_as_postgres test -f "$data/global/pg_control" \
    && pg_as_postgres test -d "$data/base"; then
    return 0
  fi
  return 1
}

# Verlangt die Cluster-Version den Relation-Mapping-Marker global/pg_filenode.map?
# PG ≤ 18: ja (RELMAPPER_FILENAME "pg_filenode.map", auch in REL_18_STABLE).
# PG ≥ 19 / unbekannt: nein — der Marker ist dann nur noch ein Warn-Hinweis.
pg_relmap_required() {
  local major="$1"
  if [[ "$major" =~ ^[0-9]+$ ]] && (( major <= 18 )); then
    return 0
  fi
  return 1
}

# Marker vorhanden? (als Cluster-Benutzer geprüft)
pg_cluster_relmap_ok() {
  local data="$1"
  if [[ -z "$data" ]]; then
    return 1
  fi
  if pg_as_postgres test -f "$data/global/pg_filenode.map"; then
    return 0
  fi
  return 1
}

# Gesamt-Check: Grundgerüst + (falls von der Cluster-Version verlangt) Relmap.
pg_cluster_ok() {
  local data="$1"
  if ! pg_cluster_basic_ok "$data"; then
    return 1
  fi
  local dv
  dv="$(pg_data_version "$data")"
  if pg_relmap_required "$dv" && ! pg_cluster_relmap_ok "$data"; then
    return 1
  fi
  return 0
}

# pg_controldata-Ausgabe (als Cluster-Benutzer). Leer bei Fehler.
pg_control_output() {
  local data="$1"
  if [[ -z "$data" ]]; then
    printf ''
    return 0
  fi
  pg_as_postgres pg_controldata -D "$data" 2>/dev/null || true
}

# Major aus pg_control (z. B. "pg_control version number: 1800" → 18).
pg_control_major() {
  local data="$1" line major=""
  while IFS= read -r line; do
    if [[ "$line" =~ pg_control[[:space:]]+version[[:space:]]+number:[[:space:]]*([0-9]+) ]]; then
      major="$(( ${BASH_REMATCH[1]} / 100 ))"
      break
    fi
  done < <(pg_control_output "$data")
  if [[ "$major" =~ ^[0-9]+$ ]]; then
    printf '%s' "$major"
  fi
  return 0
}

# Ist der Cluster laut pg_control gerade gestartet ("running")?
pg_control_state() {
  local data="$1" line state=""
  while IFS= read -r line; do
    if [[ "$line" =~ Database[[:space:]]+cluster[[:space:]]+state:[[:space:]]*([A-Za-z ]+) ]]; then
      state="${BASH_REMATCH[1]}"
      break
    fi
  done < <(pg_control_output "$data")
  printf '%s' "$state"
}

# Major-Versions-Mismatch Cluster ↔ Server? 0 = Mismatch (Achtung!), 1 = ok/unbekannt.
pg_version_mismatch() {
  local server="$1" data="$2" dv=""
  dv="$(pg_data_version "$data")"
  if [[ "$server" =~ ^[0-9]+$ ]] && [[ "$dv" =~ ^[0-9]+$ ]] && [[ "$server" != "$dv" ]]; then
    return 0
  fi
  return 1
}

# Ausführliche Diagnose für den Fehlerfall (als Cluster-Benutzer, keine Secrets).
pg_cluster_diagnostics() {
  local data="$1"
  echo "      Datenverzeichnis: $data"
  if ! pg_as_postgres test -e "$data"; then
    echo "      Verzeichnis existiert nicht oder ist nicht erreichbar — initdb legt es an."
  else
    echo "      Besitzer/Rechte:"
    pg_as_postgres stat -c '        %U:%G %a %n' "$data" 2>/dev/null || \
      echo "        (Rechte nicht lesbar — prüfen: sudo chown -R postgres:postgres $data)"
    echo "      Inhalt von $data:"
    pg_as_postgres ls -la "$data" 2>/dev/null | sed 's/^/        /' || true
    echo "      Inhalt von $data/global:"
    pg_as_postgres ls -la "$data/global" 2>/dev/null | sed 's/^/        /' || true
  fi
  local dv sv
  dv="$(pg_data_version "$data")"; sv="$(pg_server_major)"
  echo "      PG_VERSION (Cluster): ${dv:-nicht lesbar}   ·   Server: ${sv:-unbekannt}"
  local cm
  cm="$(pg_control_major "$data")"
  if [[ -n "$cm" ]]; then
    echo "      pg_control: Version $cm, State: $(pg_control_state "$data")"
  else
    echo "      pg_controldata: keine Ausgabe (Datei fehlt/korrupt oder Rechte)"
  fi
  echo "      Freier Platz:"
  df -h "$data" 2>/dev/null | tail -1 | sed 's/^/        /' || true
  echo "      Statistik (Prozesse auf diesem Cluster):"
  ps -eo pid,user,args 2>/dev/null | grep -F "$data" | grep -v grep | sed 's/^/        /' || true
}
