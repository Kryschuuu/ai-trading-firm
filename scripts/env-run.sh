#!/usr/bin/env bash
#
# ═══════════════════════════════════════════════════════════════════════════
#  scripts/env-run.sh — .env shell-unabhängig laden (v1.39.1, Befund SET-10)
# ═══════════════════════════════════════════════════════════════════════════
#
# Warum dieses Skript existiert: die Installations- und Reset-Anleitungen
# (README.md, docs/INSTALL.md, docs/HOWTO_RESET_LOKAL.md) nutzen bash-Idiome —
#
#     set -a; . ./.env; set +a          # Variablen exportieren
#     STAMP=$(date +%F-%H%M)            # Variablenzuweisung
#
# In fish ist beides ein Syntaxfehler (`set: # … : invalid variable name`,
# `fish: Unsupported use of '='`). Tückisch ist nicht der Fehler selbst, sondern
# seine Folge: `$DATABASE_URL` bleibt leer, und `pg_dump "$DATABASE_URL"` fällt
# auf die libpq-Defaults zurück (Unix-Socket, OS-Benutzer) →
# `FATAL: role "kris" does not exist`. Gemeint war die Datenbank aus der .env.
#
# Ein Parser, ein Format, jede Shell: der Kern ist ein einziges awk-Programm,
# das die Einträge je Zielshell AUSGABE-FERTIG formatiert. Bewusst awk und nicht
# bash-String-Operationen — Quote-Zeichen in `${var//…}` und `case`-Patterns sind
# der klassische Ort, an dem so etwas kaputt aussieht und kaputt geht.
#
# Verwendung
#   bash / zsh   set -a; eval "$(scripts/env-run.sh)"; set +a
#   ohne bash     eval "$(node scripts/load-env.mjs --sh)"   (fish: --fish | source)
#   fish         scripts/env-run.sh --fish | source
#   ein Befehl   scripts/env-run.sh -- npm run build      # Kindprozess mit .env
#   ein Wert     scripts/env-run.sh --print DATABASE_URL     (nur der Wert, maskiert)
#              scripts/env-run.sh --raw --print DATABASE_URL (nur der Wert, unmaskiert)
#   nur Namen    scripts/env-run.sh --keys
#   prüfen       scripts/env-run.sh --check               # Exit 1 bei Defekten
#
# Regeln (bewusst eng, damit nichts überrascht):
#   * Leerzeilen und `#`-Zeilen werden ignoriert, `export `-Präfix ist erlaubt
#   * Werte dürfen "doppelt" oder 'einfach' gequotet sein; ein ` #` hinter einem
#     UNGEQUOTETEN Wert wird abgeschnitten (dotenv-Konvention)
#   * CRLF wird toleriert (Windows-Ziegelei), `\r` verschwindet
#   * Zeile ohne `=` oder Schlüsselname außerhalb `[A-Za-z_][A-Za-z0-9_]*`
#     → Warnung auf stderr (mit Zeilennummer), kein Abbruch
#   * leere Werte bleiben erhalten (`KEY=`) — sie sind eine Aussage: "bewusst aus"
#   * keine Auswertung von `$( )`/Backticks: in der bash-Ausgabe werden `\ " $ `
#     maskiert, damit `eval` sie wörtlich nimmt. Die .env selbst wird nie gexecutet.
#   * Secrets landen nie auf stderr — Warnungen nennen Zeile und Schlüsselname
#
# Exit-Codes: 0 ok · 1 .env nicht lesbar / --check fand Fehler · 2 Bedienfehler

set -uo pipefail

ENV_FILE="${ENV_FILE:-}"
MODE="print"          # print | fish | keys | print-one | check
RAW_OUT="false"         # --raw: Key=wert unmaskiert (fuer Tools), mit jedem Modus kombinierbar
PRINT_KEY=""
CHILD=()

usage() { sed -n '4,40p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || { echo "env-run.sh: --env-file braucht einen Pfad" >&2; exit 2; }
                ENV_FILE="$2"; shift 2 ;;
    --print)    [[ $# -ge 2 ]] || { echo "env-run.sh: --print braucht einen Schlüssel" >&2; exit 2; }
                MODE="print-one"; PRINT_KEY="$2"; shift 2 ;;
    --fish)     MODE="fish"; shift ;;
    --raw)      RAW_OUT="true"; shift ;;
    --keys)     MODE="keys"; shift ;;
    --check)    MODE="check"; shift ;;
    --)         shift; CHILD=("$@"); break ;;
    -h|--help)  usage; exit 0 ;;
    *)          echo "env-run.sh: unbekannte Option: $1  (--help für Hilfe)" >&2; exit 2 ;;
  esac
done

# Projektstamm = eine Ebene über scripts/, damit der Aufruf aus jedem
# Unterordner dasselbe .env findet. `git rev-parse --show-toplevel` wäre die
# Alternative, braucht aber ein Git-Repo — dieses Skript läuft auch im
# Tarball-/Offline-Deployment.
if [[ -z "$ENV_FILE" ]]; then
  _self="${BASH_SOURCE[0]}"
  _dir="$(cd -- "$(dirname -- "$_self")" >/dev/null 2>&1 && pwd -P)"
  ENV_FILE="$(dirname -- "$_dir")/.env"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'env-run.sh: keine .env gefunden (%s)\n' "$ENV_FILE" >&2
  printf '  Vorlage anlegen: cp .env.example .env && chmod 600 .env\n' >&2
  printf '  Oder Pfad nennen: ENV_FILE=/pfad/.env scripts/env-run.sh\n' >&2
  exit 1
fi
if [[ ! -r "$ENV_FILE" ]]; then
  printf 'env-run.sh: .env nicht lesbar (%s)\n' "$ENV_FILE" >&2
  printf '  Rechte prüfen: ls -l "%s" — als Besitzer: chmod u+r "%s"\n' "$ENV_FILE" "$ENV_FILE" >&2
  exit 1
fi

# ── Der Parser (eine Quelle der Wahrheit für alle Modi) ─────────────────────
# awk-Modus-Auswahl:
#   shell → export KEY="wert" (bash/zsh: eval-sicher; bewusst mit `export`,
#            identisch zu scripts/load-env.mjs — ein Vertrag, zwei Wege)
#   fish  → set -gx KEY 'wert'
#   keys  → KEY
#   raw   → KEY=wert        (für `env KEY=wert`)
# Warnungen über Zeilennummern gehen als Zeilen mit Prefix "! " auf stderr.
parse_env() {
  awk -v mode="$1" -v want="$2" '
    BEGIN {
      # Unescaped erlaubte Zeichen in fish-Tokens (Leerzeichen muessen weg, sie
      # waeren Trenner). Bewusst als Konstante: ein Funktionsparameter namens
      # "safe" wre von awk als ZAEHLER der Argumente interpretiert worden
      # (length(safe) == 2) — der Klassiker, und still.
      SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/@:^=+,-"
      DQ   = "\""
      SQ   = "\047"
    }
    # Escaping fuer bash/zsh innerhalb "…": nur \ " $ ` sind dort wirksam.
    function esc_shell(s,   i, c, out) {
      out = ""
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (c == "\\" || c == DQ || c == "$" || c == "`") out = out "\\"
        out = out c
      }
      return out
    }
    # Escaping fuer fish-Tokens: alles auerhalb der Whitelist wird escapet.
    function esc_fish(s,   i, c, out) {
      out = ""
      if (s == "") return SQ SQ
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (index(SAFE, c) > 0) { out = out c; continue }
        if (c == " ") { out = out "\\ "; continue }
        out = out "\\" c
      }
      return out
    }
    function emit(k, v) {
      # `want != ""` ist die Frage "nur der Wert" (--print KEY) — ein Filter,
      # kein Format. Bewusst in ifs statt `if (..) print a; else print b`: mawk
      # (Debian/CachyOS-Default) nennt das sonst "return outside function body".
      if (mode == "keys") { print k; return }
      if (mode == "shell") {
        if (want != "") print esc_shell(v)
        else print "export " k "=\"" esc_shell(v) "\""
        return
      }
      if (mode == "fish") {
        if (want != "") print esc_fish(v)
        else print "set -gx " k " " esc_fish(v)
        return
      }
      if (want != "") print v
      else print k "=" v
    }
    {
      line = $0
      sub(/\r$/, "", line)
      if (line ~ /^[ \t]*$/) next                       # Leerzeile
      if (line ~ /^[ \t]*#/) next                       # Kommentar
      sub(/^[ \t]+/, "", line)
      sub(/^export[ \t]+/, "", line)
      sub(/^[ \t]+/, "", line)
      eq = index(line, "=")
      if (eq == 0) {
        printf "! %d: zeile ohne = uebersprungen: %s\n", NR, substr(line, 1, 40) > "/dev/stderr"
        bad++; next
      }
      key = substr(line, 1, eq - 1)
      val = substr(line, eq + 1)
      gsub(/[ \t]/, "", key)
      if (key !~ /^[A-Za-z_][A-Za-z0-9_]*$/) {
        printf "! %d: ungueltiger schluesselname uebersprungen: %s\n", NR, substr(key, 1, 32) > "/dev/stderr"
        bad++; next
      }
      sub(/^[ \t]+/, "", val)
      q = substr(val, 1, 1)
      if ((q == DQ || q == SQ) && length(val) >= 2 && substr(val, length(val), 1) == q) {
        val = substr(val, 2, length(val) - 2)           # voll gequotet
      } else if (q == DQ || q == SQ) {
        val = substr(val, 2)                             # Startquote ohne Ende
        sub(/[ \t].*$/, "", val)
      } else {
        sub(/[ \t]#.*$/, "", val)                         # unquotiert: #Kommentar ab
        sub(/[ \t]+$/, "", val)
      }
      if (want == "" || key == want) emit(key, val)
      n++
    }
    # Der Zaehler wird NUR im stats-Modus ausgegeben (dort auf stdout, damit der
    # Aufrufer ihn abfangen kann). Warnungen (Prefix "! ") laufen in allen Modi —
    # eine .env mit Tippfehler soll nicht stillschweigend halbvoll wirken.
    END { if (mode == "stats") printf "%d %d\n", n + 0, bad + 0 }
  ' "$ENV_FILE"
}

if [[ "$MODE" == "check" ]]; then
  # Warnungen (Präfix "! ") und Zaehlerzeile kommen von einem einzigen Durchlauf.
  stats="$(parse_env stats "" 2>&1)"
  bad="$(printf '%s\n' "$stats"   | sed -n 's/^[0-9]* \([0-9]*\)$/\1/p' | tail -1)"
  total="$(printf '%s\n' "$stats" | sed -n 's/^\([0-9]*\) [0-9]*$/\1/p' | tail -1)"
  printf '%s\n' "$stats" | grep '^! ' >&2 || true
  if [[ "${bad:-0}" != "0" ]]; then
    printf 'env-run.sh: %s fehlerhafte Zeile(n) in %s\n' "$bad" "$ENV_FILE" >&2
    exit 1
  fi
  printf 'env-run.sh: .env ok (%s) — %s Eintraege\n' "$ENV_FILE" "${total:-0}"
  exit 0
fi

# Kommando-Modus: Environment aus der .env bauen und Kindprozess ersetzten.
if [[ ${#CHILD[@]} -gt 0 ]]; then
  mapfile -t env_args < <(parse_env raw "" 2>/dev/null)
  if [[ ${#env_args[@]} -eq 0 ]]; then
    printf 'env-run.sh: .env enthaelt keine gueltigen KEY=WERT-Zeilen (%s)\n' "$ENV_FILE" >&2
    exit 1
  fi
  exec env "${env_args[@]}" "${CHILD[@]}"
fi

# Die Modi-Namen der CLI und die von awk sind nicht identisch: `print` heißt in
# awk "shell", `print-one` ist dasselbe Format mit Filter (`want`). Ein Fall
# strukturiert, statt zwei Parser.
awk_mode="shell"
case "$MODE" in
  fish) awk_mode="fish" ;;
  keys) awk_mode="keys" ;;
esac
# --raw ist ein Format-Schalter, kein Modus: `--raw --print KEY` und `--raw`
# allein arbeiten mit demselben Parser (awk-Modus "raw").
if [[ "$RAW_OUT" == "true" ]]; then
  awk_mode="raw"
fi

# Der Schluesselfilter gilt fuer jedes Format — sonst liefert `--raw --print KEY`
# versehentlich die ganze Datei.
if [[ "$MODE" == "print-one" ]]; then
  parse_env "$awk_mode" "$PRINT_KEY"
else
  parse_env "$awk_mode" ""
fi
exit $?
