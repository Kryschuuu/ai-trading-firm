/**
 * Konsolen-Ausgabeformat (v1.39.1) — ASCII-sichere Transliteration.
 *
 * Problem: Die CLI-Logzeilen sind deutsch formuliert und enthielten typografische
 * Unicode-Zeichen (Gedankenstrich `—`, Mittelpunkt `·`, Pfeil `→`, `≥`,
 * deutsche Anführungszeichen, Umlaute). Node schreibt UTF-8 nach stdout — auf
 * Windows-Terminals mit Legacy-Codepage (CP850/CP1252) oder bei umgeleiteter
 * Ausgabe (`| tee`, `> log.txt`, PowerShell 5.1-Capture) erscheint daraus
 * Mojibake („â€“, „Ã¼“, „Â·“): der Screenshot-Bug von `npm run market:sync`.
 *
 * Lösung: DIESE eine Funktion ist die einzige Übersetzungsstelle. Sie wird
 * ausschließlich an der Konsole-Grenze angewendet (CLI-Druckpfad,
 * `defaultSyncLogger`) — die Rohwerte in `SyncResult`, `lines`-Rückgaben und
 * Tests bleiben unberührt, damit Automatisierung (JSON) und Assertions nichts
 * von der Terminal-Darstellung erben.
 *
 * Regel: zuerst die bekannten Sonderzeichen gezielt übersetzen (Lesbarkeit),
 * dann Umlaute standardkonform (DIN 5008: ae/oe/ue/ss), zuletzt alles Rest-
 * nicht-ASCII verwerfen — eine Zeile kann danach kein Mojibake mehr erzeugen,
 * egal welche Codepage das Terminal hat.
 */

/** Zeichenweise Übersetzung: typografische Symbole → ASCII-Äquivalent. */
const SYMBOL_MAP: Record<string, string> = {
  "—": "-",
  "–": "-",
  "−": "-",
  "·": "|",
  "•": "*",
  "→": "->",
  "←": "<-",
  "⇒": "=>",
  "≥": ">=",
  "≤": "<=",
  "…": "...",
  "×": "x",
  "✓": "ok",
  "✔": "ok",
  "✗": "x",
  "✘": "x",
  "„": '"',
  "“": '"',
  "”": '"',
  "«": '"',
  "»": '"',
  "‘": "'",
  "’": "'",
  "´": "'",
};

/** Deutsche Umlaute nach DIN 5008 (Sortier-/Übertragungsalphabet). */
const UMLAUT_MAP: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  Ä: "Ae",
  Ö: "Oe",
  Ü: "Ue",
  ß: "ss",
};

/**
 * Macht eine Zeile für JEDE Konsole sicher: bekannte Symbole werden übersetzt,
 * Umlaute transkribiert, alle übrigen Nicht-ASCII-Zeichen (Steuerzeichen,
 * Emoji, fremde Schriften) entfernt. Idempotent — eine bereits ASCII-reine
 * Zeile bleibt byteidentisch.
 */
export function toConsoleAscii(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch in SYMBOL_MAP) {
      out += SYMBOL_MAP[ch];
    } else if (ch in UMLAUT_MAP) {
      out += UMLAUT_MAP[ch];
    } else if (ch.charCodeAt(0) < 128) {
      out += ch;
    }
    // alles andere (>\u007f) entfällt bewusst — kein Ersatzzeichen, das in
    // keiner Codepage sicher ist.
  }
  return out;
}

/** `true`, wenn der Text ausschließlich druckbares ASCII plus Zeilenumbruch enthält. */
export function isAsciiSafe(text: string): boolean {
  return /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text);
}
