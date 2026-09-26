#!/usr/bin/env bash
# Erst-Warmup und wiederholbarer Sync der vier von Missionen genutzten Venues.
# Fehler je Venue werden gesammelt, der Lauf wird für die übrigen Venues fortgesetzt.
set -u

venues=(IBKR PAPER BINANCE KRAKEN)
failed=0

for venue in "${venues[@]}"; do
  printf '\n[market-sync:mission-venues] === %s ===\n' "$venue"
  npm run market:sync -- --venue="$venue" "$@"
  status=$?
  if (( status != 0 )); then
    printf '[market-sync:mission-venues] %s fehlgeschlagen (Exit %s); fahre fort.\n' "$venue" "$status" >&2
    failed=1
  fi
done

if (( failed )); then
  echo '[market-sync:mission-venues] unvollständig — Venue-Flags/Allowlist und Manifest prüfen.' >&2
  exit 1
fi

echo '[market-sync:mission-venues] alle vier Venue-Läufe erfolgreich.'
