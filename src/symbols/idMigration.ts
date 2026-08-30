/**
 * Einmalige Instrument-ID-Normalisierung (SYM-007, §3.4) — Kernlogik, frei
 * von CLI/Prozess-Code, damit sie aus `scripts/normalize-instrument-ids.ts`
 * UND den Tests genutzt werden kann.
 *
 * Ziel: Bestände, die VOR der zentralen Symbol-Normalisierung geschrieben
 * wurden (Registry-Seed `data/universe/instruments.ndjson`,
 * Historical Store `data/history/candles.ndjson`), werden auf strukturelle
 * Konsistenz geprüft und — nur dort, wo sie objektiv kaputt sind — umbenannt.
 *
 * Konservative Reparaturregeln (rotes Banner: **nichts wird geraten**):
 *
 *  1. UMBENANNT wird nur bei struktureller Korruption:
 *       - Venue-Kleinschreibung (`kraken:BTC/USD`),
 *       - `id ≠ venue:symbol` (Registry-Zeile) bzw. ID-Präfix ≠ venue-Feld
 *         (History-Zeile),
 *       - dabei wird das Ziel immer aus dem SYMBOL-Feld abgeleitet (das ist
 *         die Autorität; die ID ist abgeleitet) und auf die bevorzugte
 *         Speicherform gebracht.
 *  2. EMPFEHLUNG (Advisory, keine Änderung) gibt es für legale, aber nicht
 *     bevorzugte Notationen (`PAPER:EURUSD=X` statt `PAPER:EUR/USD`,
 *     `KRAKEN:BTC-USD` statt `KRAKEN:BTC/USD`). Der Report macht den Drift
 *     sichtbar; ein Rewrite würde Registry-Seed-Bytes und Referenzen
 *     (Watchlist, UI) ohne Not brechen.
 *  3. ÜBERSPRUNGEN wird, was nicht parsebar ist (kaputtes JSON, ungültige
 *     Venue, unparsebares Symbol) — niemals repariert. Dito Kollisionen:
 *     münden zwei verschiedene Quell-IDs in dieselbe Ziel-ID, bleiben beide
 *     unangetastet und werden gemeldet (kein stilles Serien-Merging).
 *
 * Bevorzugte Speicherform je Venue (`preferredStorageSymbol`): die venue-
 * native Form (`BITUNIX:BTCUSDT`, `IBKR:EUR.USD`, `DYDX:BTC-USD`); KRAKEN
 * nutzt historisch die Slash-Notation (`KRAKEN:BTC/USD`, Kraken-`wsname`).
 * Die kanonische Form (`BTC/USD`) bleibt über `tryNormalizeVenueSymbol`
 * jederzeit ableitbar.
 *
 * Idempotent: ein zweiter Lauf ändert nichts mehr (keine Korruption, keine
 * Duplikate, Advisories bleiben bestehen).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tryNormalizeVenueSymbol } from "./normalize";
import { getVenueProfile, DEFAULT_PROFILE, type VenueSymbolProfile } from "./venueProfiles";

/** Dateityp des Bestands. */
export type StoreKind = "registry" | "history";

/** Eine umbenannte ID (strukturelle Korruption, repariert). */
export interface IdRename {
  line: number;
  from: string;
  to: string;
  why: string;
}

/** Eine Empfehlung ohne Änderung (legale, nicht bevorzugte Notation). */
export interface IdAdvisory {
  line: number;
  id: string;
  suggested: string;
  note: string;
}

/** Eine übersprungene Zeile (nie repariert, Grund + Snippet). */
export interface IdSkipped {
  line: number;
  reason: string;
  snippet: string;
}

/** Ergebnisbericht eines Laufs. */
export interface NormalizeIdsReport {
  file: string;
  kind: StoreKind;
  read: number;
  unchanged: number;
  renamed: IdRename[];
  advisories: IdAdvisory[];
  skipped: IdSkipped[];
  /** Byte-identische Dubletten (unter --apply entfernt). */
  duplicates: number;
  /** Geplante, aber wegen Zielkollision NICHT ausgeführte Umbenennungen. */
  collisions: number;
  written: number;
  backupPath: string | null;
  dryRun: boolean;
}

export interface NormalizeIdsOptions {
  file: string;
  kind: StoreKind;
  /** Nur lesen + Report; Datei/Backup nicht anfassen (Default-Verhalten). */
  dryRun?: boolean;
}

/**
 * Bevorzugte Speicherform eines kanonischen Symbols für die Registry/den
 * Historical Store: venue-nativ, außer KRAKEN (dort historisch Slash =
 * `wsname`-Konvention, siehe universe-Seed `KRAKEN:BTC/USD`).
 */
export function preferredStorageSymbol(profile: VenueSymbolProfile, canonical: string): string {
  return profile.venue === "KRAKEN" ? canonical : profile.toVenueNative(canonical);
}

type RowVerdict =
  | { action: "unchanged" }
  | { action: "rename"; from: string; to: string; why: string }
  | { action: "advisory"; id: string; suggested: string; note: string }
  | { action: "skip"; reason: string };

/** Normalisiert ein Venue-Feld (NFKC/Trim/Uppercase); `null` bei ungültig. */
function cleanVenue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.normalize("NFKC").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{1,15}$/.test(v) ? v : null;
}

/**
 * Bewertet eine Registry-Zeile (`{id, venue, symbol, …}`). Liefert das Urteil
 * plus — bei Umbenennung — die neue Zeile (Feldreihenfolge bleibt erhalten).
 */
function judgeRegistryRow(row: Record<string, unknown>): { verdict: RowVerdict; next?: Record<string, unknown> } {
  const venueU = cleanVenue(row.venue);
  if (!venueU) return { verdict: { action: "skip", reason: "Venue ungültig" } };
  if (typeof row.symbol !== "string" || row.symbol.length === 0) {
    return { verdict: { action: "skip", reason: "symbol fehlt/kein String" } };
  }
  const norm = tryNormalizeVenueSymbol(venueU, row.symbol);
  if (!norm.ok) return { verdict: { action: "skip", reason: `Symbol nicht normalisierbar (${norm.reason})` } };

  const profile = getVenueProfile(venueU) ?? DEFAULT_PROFILE;
  const preferredSymbol = preferredStorageSymbol(profile, norm.value.canonical);
  const derivedId = `${venueU}:${row.symbol}`;
  const idIsConsistent = row.id === derivedId && row.venue === venueU;
  if (!idIsConsistent) {
    // Strukturelle Korruption: ID/Venue-Case weicht ab. Symbol-Feld ist die
    // Autorität → beide abgeleiteten Felder neu setzen (Ziel: Speicherform).
    const next: Record<string, unknown> = { ...row };
    next.venue = venueU;
    next.symbol = preferredSymbol;
    next.id = `${venueU}:${preferredSymbol}`;
    return {
      verdict: {
        action: "rename",
        from: typeof row.id === "string" ? row.id : derivedId,
        to: `${venueU}:${preferredSymbol}`,
        why: "ID/Venue inkonsistent (strukturelle Reparatur)",
      },
      next,
    };
  }
  if (row.symbol !== preferredSymbol) {
    return {
      verdict: {
        action: "advisory",
        id: derivedId,
        suggested: `${venueU}:${preferredSymbol}`,
        note: "legale, aber nicht bevorzugte Notation",
      },
    };
  }
  return { verdict: { action: "unchanged" } };
}

/**
 * Bewertet eine History-Zeile (`{instrumentId, venue, …}`). Autorität ist das
 * `venue`-Feld; der Symbolteil kommt aus der `instrumentId`.
 */
function judgeHistoryRow(row: Record<string, unknown>): { verdict: RowVerdict; next?: Record<string, unknown> } {
  const idRaw = row.instrumentId;
  if (typeof idRaw !== "string" || idRaw.length === 0) {
    return { verdict: { action: "skip", reason: "instrumentId fehlt/kein String" } };
  }
  const idx = idRaw.indexOf(":");
  if (idx <= 0) return { verdict: { action: "skip", reason: "instrumentId ohne VENUE:-Präfix" } };
  const idVenue = idRaw.slice(0, idx);
  const symbolPart = idRaw.slice(idx + 1);
  if (symbolPart.includes(":")) {
    return { verdict: { action: "skip", reason: "instrumentId mit mehr als einem Doppelpunkt" } };
  }
  const venueU = cleanVenue(row.venue) ?? cleanVenue(idVenue);
  if (!venueU) return { verdict: { action: "skip", reason: "Venue ungültig" } };

  const norm = tryNormalizeVenueSymbol(venueU, symbolPart);
  if (!norm.ok) return { verdict: { action: "skip", reason: `Symbol nicht normalisierbar (${norm.reason})` } };

  const profile = getVenueProfile(venueU) ?? DEFAULT_PROFILE;
  const preferredSymbol = preferredStorageSymbol(profile, norm.value.canonical);
  const structuralProblem =
    idVenue !== venueU || (typeof row.venue === "string" && cleanVenue(row.venue) !== row.venue);
  if (structuralProblem) {
    const next: Record<string, unknown> = { ...row };
    next.venue = venueU;
    next.instrumentId = `${venueU}:${preferredSymbol}`;
    return {
      verdict: {
        action: "rename",
        from: idRaw,
        to: `${venueU}:${preferredSymbol}`,
        why: "ID-Präfix/Venue inkonsistent (strukturelle Reparatur)",
      },
      next,
    };
  }
  const currentId = `${venueU}:${symbolPart}`;
  if (symbolPart !== preferredSymbol) {
    return {
      verdict: {
        action: "advisory",
        id: currentId,
        suggested: `${venueU}:${preferredSymbol}`,
        note: "legale, aber nicht bevorzugte Notation",
      },
    };
  }
  return { verdict: { action: "unchanged" } };
}

/** Erstellt ein konsistentes Backup (`<file>.bak-<ISO>`, chmod 600). */
function backupFile(file: string, raw: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${file}.bak-${stamp}`;
  writeFileSync(backupPath, raw, { mode: 0o600 });
  return backupPath;
}

/**
 * Normalisiert eine Bestandsdatei. Bei `dryRun` (Default im Skript) wird
 * nichts geschrieben und kein Backup angelegt. Wirft bei fehlgeschlagenem
 * Backup (das Original bleibt dann garantiert unverändert).
 */
export function normalizeIdFile(opts: NormalizeIdsOptions): NormalizeIdsReport {
  const file = path.resolve(opts.file);
  const report: NormalizeIdsReport = {
    file,
    kind: opts.kind,
    read: 0,
    unchanged: 0,
    renamed: [],
    advisories: [],
    skipped: [],
    duplicates: 0,
    collisions: 0,
    written: 0,
    backupPath: null,
    dryRun: opts.dryRun === true,
  };
  if (!existsSync(file)) return report;

  const raw = readFileSync(file, "utf8");
  const lines = raw.split("\n");

  // Phase 1: Zeilen bewerten; `outLines` hält je Index die Ausgabezeile
  // (Korruption-Reparatur als neue Zeile, sonst Original — Blank/Comment unangetastet).
  const outLines: string[] = new Array(lines.length);
  let lineNo = 0;
  for (const line of lines) {
    const idx = lineNo;
    lineNo += 1;
    const t = line.trim();
    if (!t || t.startsWith("#")) {
      outLines[idx] = line;
      continue;
    }
    report.read += 1;

    let row: unknown;
    try {
      row = JSON.parse(t);
    } catch {
      report.skipped.push({ line: lineNo, reason: "ungültiges JSON", snippet: t.slice(0, 120) });
      outLines[idx] = line;
      continue;
    }
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      report.skipped.push({ line: lineNo, reason: "Zeile ist kein Objekt", snippet: t.slice(0, 120) });
      outLines[idx] = line;
      continue;
    }
    const rec = row as Record<string, unknown>;
    const { verdict, next } = opts.kind === "registry" ? judgeRegistryRow(rec) : judgeHistoryRow(rec);

    switch (verdict.action) {
      case "unchanged":
        report.unchanged += 1;
        outLines[idx] = line;
        break;
      case "skip":
        report.skipped.push({ line: lineNo, reason: verdict.reason, snippet: t.slice(0, 120) });
        outLines[idx] = line;
        break;
      case "advisory":
        report.advisories.push({ line: lineNo, id: verdict.id, suggested: verdict.suggested, note: verdict.note });
        report.unchanged += 1;
        outLines[idx] = line;
        break;
      case "rename":
        report.renamed.push({ line: lineNo, from: verdict.from, to: verdict.to, why: verdict.why });
        outLines[idx] = JSON.stringify(next);
        break;
    }
  }

  // Phase 2: Zielkollisionen — münden UNTERSCHIEDLICHE Quell-IDs in dieselbe
  // Ziel-ID, werden die betroffenen Umbenennungen zurückgenommen (kein
  // stilles Serien-Merging; der Operator entscheidet).
  {
    const byTarget = new Map<string, Set<string>>();
    for (const r of report.renamed) {
      const set = byTarget.get(r.to) ?? new Set<string>();
      set.add(r.from);
      byTarget.set(r.to, set);
    }
    const colliding = new Set([...byTarget].filter(([, sources]) => sources.size > 1).map(([t]) => t));
    if (colliding.size > 0) {
      const kept: typeof report.renamed = [];
      for (const r of report.renamed) {
        if (colliding.has(r.to)) {
          report.collisions += 1;
          report.advisories.push({
            line: r.line,
            id: r.from,
            suggested: r.to,
            note: "Umbenennung NICHT ausgeführt — Zielkollision mit anderer Quell-ID",
          });
          outLines[r.line - 1] = lines[r.line - 1]; // Original zurück
        } else {
          kept.push(r);
        }
      }
      report.renamed = kept;
      report.advisories.sort((a, b) => a.line - b.line);
    }
  }

  // Phase 3: Byte-identische Dubletten (komplette Zeile) droppen — die erste
  // gewinnt. Reihenfolge bleibt erhalten (idempotent).
  const seenLines = new Set<string>();
  const deduped: string[] = [];
  for (const line of outLines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) {
      deduped.push(line);
      continue;
    }
    if (seenLines.has(t)) {
      report.duplicates += 1;
      continue;
    }
    seenLines.add(t);
    deduped.push(line);
  }

  const changed = report.renamed.length > 0 || report.duplicates > 0;
  report.written = deduped.filter((l) => l.trim() && !l.trim().startsWith("#")).length;

  if (changed) {
    if (!report.dryRun) {
      report.backupPath = backupFile(file, raw);
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, deduped.join("\n"), { mode: 0o600 });
      renameSync(tmp, file);
    }
  }
  return report;
}

/** Menschenlesbarer Report (deutsch, eine Zeile pro Eintrag). */
export function formatNormalizeIdsReport(report: NormalizeIdsReport): string[] {
  const rel = path.relative(process.cwd(), report.file) || report.file;
  const lines: string[] = [
    `[normalize-ids] Datei: ${rel} (${report.kind}) — gelesen: ${report.read}, unverändert: ${report.unchanged}, ` +
      `umbenannt: ${report.renamed.length}, empfohlen: ${report.advisories.length}, übersprungen: ${report.skipped.length}, ` +
      `dubletten: ${report.duplicates}, kollisionen: ${report.collisions}`,
  ];
  for (const r of report.renamed) {
    lines.push(`  RENAME  Zeile ${r.line}: ${r.from} → ${r.to} (${r.why})`);
  }
  for (const a of report.advisories) {
    lines.push(`  HINWEIS Zeile ${a.line}: ${a.id} → Vorschlag ${a.suggested} (${a.note})`);
  }
  for (const s of report.skipped) {
    lines.push(`  SKIP    Zeile ${s.line}: ${s.reason} — ${s.snippet}`);
  }
  if (report.backupPath) {
    lines.push(`[normalize-ids] Backup: ${path.relative(process.cwd(), report.backupPath)}`);
  } else if (report.dryRun && (report.renamed.length > 0 || report.duplicates > 0)) {
    lines.push("[normalize-ids] DRY-RUN: nichts geschrieben (mit --apply anwenden; Backup wird dann angelegt).");
  }
  if (!report.dryRun && report.renamed.length === 0 && report.duplicates === 0) {
    lines.push("[normalize-ids] nichts zu normalisieren — Datei unverändert.");
  }
  return lines;
}
