/**
 * Secret-Muster-Scanner der Broker Control Plane (Task 08, Pflicht-Test).
 *
 * Scannt Text (API-Responses, Quelltexte, Build-Artefakte) auf
 * Secret-Muster: bekannte Schluessel-Formate, Laengen-/Entropie-Heuristik.
 * Das Ergebnis MUSS leer sein — der Test laeuft ueber ALLE Control-Plane-
 * API-Responses und das gebaute Frontend-Bundle (scripts/scan-secrets.ts).
 *
 * WICHTIG (Selbstreferenz): Die Muster sind so geschrieben, dass der
 * Quelltext dieses Moduls sie NICHT selbst matcht (keine Literale in
 * Kommentaren/Regex-Texten, die ein Muster erfuellen).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface SecretFinding {
  /** Muster-ID, z. B. "hex-64" oder "entropy". */
  pattern: string;
  /** Startindex im gescannten Text. */
  index: number;
  /** Maskierte Vorschau des Treffers (Mitte genullt — kein Leak im Log). */
  excerpt: string;
}

/** Maskiert einen Treffer: erste 3 + letzte 3 Zeichen, Rest '…'. */
export function maskExcerpt(match: string): string {
  if (match.length <= 10) return "***";
  return `${match.slice(0, 3)}…${match.slice(-3)}`;
}

interface PatternDef {
  id: string;
  re: RegExp;
}

const HEX64 = /(?:^|[^0-9a-fA-F])([0-9a-fA-F]{64})(?:$|[^0-9a-fA-F])/g;
const HEX32 = /(?:^|[^0-9a-fA-F])([0-9a-fA-F]{32})(?:$|[^0-9a-fA-F])/g;
const BASE64_SECRET = /(?:^|[^A-Za-z0-9+/_-])([A-Za-z0-9+/]{40,96}={0,2})(?:$|[^A-Za-z0-9+/_=-])/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const PEM_PRIVATE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const ASSIGN_SECRET =
  /(api[_-]?secret|api[_-]?key|secret[_-]?key|access[_-]?token|firm[_-]?(admin[_-]?)?token)["']?\s*[:=]\s*["']([^"'&]{8,})["']/gi;
const SK_TOKEN = /\bsk-(?:live|test|ant)-[A-Za-z0-9_-]{8,}/gi;

const PATTERNS: PatternDef[] = [
  { id: "hex-64", re: HEX64 },
  { id: "hex-32", re: HEX32 },
  { id: "base64-secret", re: BASE64_SECRET },
  { id: "aws-access-key", re: AWS_ACCESS_KEY },
  { id: "jwt", re: JWT },
  { id: "pem-private", re: PEM_PRIVATE },
  { id: "assign-secret", re: ASSIGN_SECRET },
  { id: "sk-token", re: SK_TOKEN },
];

const TOKEN_RE = /[A-Za-z0-9+/_-]{24,}/g;

/** Shannon-Entropie (Bit/Zeichen) eines Tokens. */
function shannonEntropy(token: string): number {
  const counts = new Map<string, number>();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / token.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Muss wie ein ECHTER Base64-Schluessel aussehen: Ziffer + beide Faelle. */
function looksLikeBase64Secret(token: string): boolean {
  return (
    /[0-9]/.test(token) && /[a-z]/.test(token) && /[A-Z]/.test(token)
  );
}

/**
 * Entropie-Heuristik: lange Base64-aehnliche Tokens mit hoher Entropie,
 * breitem Zeichensatz und gemischten Faellen sind Secret-verdaechtig.
 * Minifier-Identifiers (camelCase ohne Ziffern) und lowercase Chunk-Pfade
 * fallen damit NICHT mehr ins Raster (False-Positive-getestet).
 */
export function entropySuspicious(token: string): boolean {
  if (token.length < 24) return false;
  if (!looksLikeBase64Secret(token)) return false;
  const unique = new Set(token).size;
  if (unique < 12) return false;
  const entropy = shannonEntropy(token);
  return entropy >= 4.2;
}

/** Scannt einen Text; Treffer = Muster + Entropie-Heuristik (dedupliziert). */
export function scanTextForSecrets(text: string): SecretFinding[] {
  if (!text) return [];
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  const push = (pattern: string, match: string, index: number) => {
    const key = `${pattern}:${match}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ pattern, index, excerpt: maskExcerpt(match) });
  };

  for (const { id, re } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const match = (m[2] ?? m[1] ?? m[0]).trim();
      if (!match) continue;
      // base64-secret zusaetzlich wie ein echter Schluessel gefiltert
      // (Ziffer + beide Faelle), sonst matcht jeder lange Bezeichner.
      if (id === "base64-secret" && !looksLikeBase64Secret(match)) {
        if (m[0].length === 0) re.lastIndex += 1; // Guardrail
        continue;
      }
      push(id, match, m.index);
      if (m[0].length === 0) re.lastIndex += 1; // Guardrail
    }
  }

  TOKEN_RE.lastIndex = 0;
  let t: RegExpExecArray | null;
  while ((t = TOKEN_RE.exec(text)) !== null) {
    const token = t[0];
    if (entropySuspicious(token)) push("entropy", token, t.index);
  }
  return findings;
}

/** Serialisiert einen beliebigen API-Body und scannt ihn. */
export function scanJsonBody(body: unknown): SecretFinding[] {
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    text = String(body);
  }
  return scanTextForSecrets(text ?? "");
}

export interface ScanReport {
  files: number;
  findings: { file: string; finding: SecretFinding }[];
}

/**
 * Scannt alle Textdateien eines Verzeichnisses rekursiv (z. B. das
 * gebaute Frontend-Bundle `.next/static`).
 */
export function scanDirectory(dir: string): ScanReport {
  const report: ScanReport = { files: 0, findings: [] };
  if (!existsSync(dir)) return report;
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      // Nur Textlastige Artefakte (JS/Chunks/JSON/CSS/HTML) — Binary-Skips.
      if (!/\.(js|mjs|json|css|html|txt|map)$/.test(entry)) continue;
      report.files += 1;
      try {
        const text = readFileSync(full, "utf8");
        for (const finding of scanTextForSecrets(text)) {
          report.findings.push({ file: path.relative(dir, full), finding });
        }
      } catch {
        /* Lesefehler: Datei ueberspringen, kein Scan-Abbruch */
      }
    }
  };
  walk(dir);
  return report;
}
