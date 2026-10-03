/**
 * Lokalitäts-Klassifikation für Provider-Basis-URLs (STX-08-05 / STX-21).
 *
 * ── Warum es diese Datei gibt ───────────────────────────────────────────────
 * Der Validator-Agent verspricht mit der Policy `LOCAL_FREE` einen lokalen,
 * cloud-freien Pfad. Die Provider-Liste dahinter enthält aber `openai` — einen
 * OpenAI-*kompatiblen* Client, dessen Endpunkt über `LLM_BASE_URL` frei
 * konfigurierbar ist (`ollama` analog über `OLLAMA_BASE_URL`). Der bisherige
 * Filter vor dem Aufruf prüfte nur Toggles, keine Endpunkte: „lokal" war damit
 * eine Default-Konfiguration, keine durchgesetzte Eigenschaft. Diese Datei
 * liefert die **reine** Prüfung, die der Agent vor jedem Aufruf anwendet.
 *
 * ── Definition „lokal" (literale Host-Prüfung) ──────────────────────────────
 *  1. IPv4-Loopback `127.0.0.0/8` — jede Adresse, deren erstes Oktett 127 ist.
 *  2. IPv6-Loopback `::1` (auch ausgeschrieben `0:0:0:0:0:0:0:1`) sowie die
 *     IPv4-gemappten Formen (`::ffff:127.0.0.1` ⇒ `[::ffff:7f00:1]`), deren
 *     eingebettete IPv4-Adresse Loopback ist.
 *  3. `localhost` und jeder Name, der auf `.localhost` endet (RFC 6761: solche
 *     Namen zeigen per Standard auf die Loopback-Schnittstelle).
 *  4. Die reservierten Namensräume `.test` und `.invalid` (RFC 6761). Sie sind
 *     **öffentlich nicht auflösbar** — ein Cloud-Endpunkt kann sich dahinter
 *     nicht verbergen. Ohne diese Ausnahme würde die bestehende, gemockte
 *     Ollama-Testreihe (`http://ollama.test:11434`) unter `LOCAL_FREE` aus
 *     gesperrt, obwohl sie nie einen öffentlichen Host erreicht.
 *
 * Alles andere ist **nicht** lokal (fail-closed): öffentliche Domains,
 * intranet-/container-interne Kurznamen ohne Punkt (`http://ollama:11434`),
 * private Netze ohne Loopback (z. B. `192.168.x.x`) sowie nicht-`http(s)`-
 * Schemata, URLs mit Credentials (Userinfo) oder unparsebare Werte. Ein
 * Kurzname oder eine private IP fällt bewusst aus: Der Agent sendet nur an
 * einen Endpunkt, der garantiert auf der Maschine selbst liegt — die
 * Exclusion ist am Zähler sichtbar, nicht still.
 *
 * ── Nicht-Ziele ─────────────────────────────────────────────────────────────
 * Kein DNS-Lookup, keine Namensauflösung, kein `fetch`-Probeaufruf: geprüft
 * wird ausschließlich der übergebene String. Das ist deterministisch testbar
 * und kann von einem manipulierten Resolver nicht beeinflusst werden —
 * geprüft wird exakt das, was konfiguriert ist. Der Aufrufer reicht deshalb
 * den **effektiven** Basis-URL herein (`providerConfigFromEnv()`, also
 * Env-Override oder Default), nicht den Default allein.
 *
 * Die Prüfung entscheidet nichts und protokolliert nichts; sie liefert nur
 * `true`/`false`. Zähler und Dokumentation liegen beim Aufrufer
 * (`src/strategies/validator/agent.ts`).
 */

/**
 * Erlaubt sind nur die Schemata, die der Provider-Client ohnehin verwendet
 * (`sanitizeBaseUrl()` verwirft alles andere). Credentials in der URL werden
 * wie dort abgewiesen: sie landen sonst in Logs und Fehlermeldungen.
 */
export function isLocalEndpointBaseUrl(raw: string | null | undefined): boolean {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return false;
  let host: string;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    host = parsed.hostname;
  } catch {
    return false;
  }
  return isLocalHostLiteral(host);
}

/**
 * Literale Host-Prüfung ohne Auflösung — siehe Modulkopf für die Definition.
 * `host` darf die IPv6-Klammerform (`[::1]`) tragen; Groß-/Kleinschreibung
 * spielt keine Rolle.
 */
export function isLocalHostLiteral(rawHost: string | null | undefined): boolean {
  let host = typeof rawHost === "string" ? rawHost.trim().toLowerCase() : "";
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // Zonen-/Scope-Suffix (z. B. `%25eth0`) abschneiden, falls vorhanden.
  const zone = host.indexOf("%");
  if (zone >= 0) host = host.slice(0, zone);
  if (!host) return false;

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".test") || host.endsWith(".invalid")) return true;
  if (isLoopbackIpv4Literal(host)) return true;

  const groups = ipv6Groups(host);
  return groups !== null && isLoopbackIpv6Groups(groups);
}

/** `127.0.0.0/8` — erstes Oktett 127, Oktette validiert. */
function isLoopbackIpv4Literal(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    if (octet > 255) return false;
    octets.push(octet);
  }
  return octets[0] === 127;
}

/** IPv6-Literal → acht 16-Bit-Gruppen; `null`, wenn kein gültiges Literal. */
function ipv6Groups(host: string): number[] | null {
  if (!host.includes(":")) return null;

  // Eingebettete IPv4-Punktnotation (`::ffff:127.0.0.1`) in zwei Hex-Gruppen
  // überführen; `new URL()` normalisiert sie meist schon selbst.
  let value = host;
  const dotted = value.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = dotted[1].split(".").map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
    if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    value = `${value.slice(0, dotted.index)}${high}:${low}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** `::1` bzw. eine IPv4-gemappte Form mit Loopback-Adresse in den letzten 32 Bit. */
function isLoopbackIpv6Groups(groups: readonly number[]): boolean {
  if (groups.length !== 8) return false;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if (groups[5] === 0xffff && groups.slice(0, 5).every((group) => group === 0)) {
    return ((groups[6] << 16) | groups[7]) >>> 24 === 127;
  }
  return false;
}
