/**
 * SEC-04 (Laufzeit): Der Bitunix-Public-WS ist der einzige Ort, an dem das
 * Projekt `ws` gegen einen Netzwerk-Peer oeffnet. Getestet wird die Sicht des
 * Angreifers auf genau diesen Pfad:
 *
 *   1. Fail-Closed-Guard: eine verwundbare `ws`-Installation (< 8.21.0) darf
 *      gar nicht erst einen Socket bekommen — auch dann nicht, wenn jemand die
 *      Dependency nach dem Deployment auf einen alten Stand zieht.
 *   2. Harte Payload-Kappe: ein boesartiger/uebernommener WS-Endpunkt darf den
 *      Prozess nicht ueber eine Flut kleiner Fragmente in die
 *      Speichererschoepfung treiben (Angriffsmuster aus CVE-2026-48779).
 *   3. Kein `close(code, reason)` mit ununterbundenem Reason-Puffer
 *      (Angriffsmuster aus CVE-2026-45736).
 *
 * Die Fragment-Flut wird mit echten, roh geschriebenen WebSocket-Frames gegen
 * den echten `ws`-Client gefahren — kein Mock des Transports.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket as NodeWebSocket } from "ws";
import { BitunixApiError } from "../src/brokers/bitunix/errors";
import { loadBitunixConfig } from "../src/brokers/bitunix/config";
import {
  BitunixPublicWs,
  MIN_WS_VERSION,
  WS_MAX_PAYLOAD_BYTES,
  assertPatchedWsVersion,
  loadWsRuntime,
  openHardenedWs,
  wsClientOptions,
  type WsLike,
  type WsRuntime,
} from "../src/brokers/bitunix/ws";

function cfg(port: number) {
  return loadBitunixConfig({
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_WS_URL: `ws://127.0.0.1:${port}/public/`,
  });
}

/** Baut einen unmaskierten Server-Frame (RFC 6455, Server sendet ohne Maske). */
function frame(fin: boolean, opcode: number, payload: Buffer): Buffer {
  const first = (fin ? 0x80 : 0x00) | opcode;
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([first, payload.length]), payload]);
  }
  if (payload.length < 65536) {
    const head = Buffer.from([first, 126, payload.length >> 8, payload.length & 0xff]);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.alloc(10);
  head[0] = first;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([head, payload]);
}

test("SEC-04: Guard lehnt jede verwundbare oder unklare ws-Version fail-closed ab", () => {
  for (const unsafe of [
    undefined, null, 8, "", "8.0.0", "8.17.1", "8.18.0", "8.18.3", "8.20.0", "8.20.1",
    "^8.21.0", "~8.21.0", ">=8.21.0", "8.x", "latest", "8.21.0-rc.1", "8.21.0+build",
    "8.021.0", "9007199254740992.21.0",
  ]) {
    assert.throws(
      () => assertPatchedWsVersion(unsafe),
      (err: unknown) => {
        assert.ok(err instanceof BitunixApiError, "Fehlertyp der Bitunix-Taxonomie erwartet");
        assert.equal(err.code, "BITUNIX_DISABLED");
        assert.match(err.message, /ws/);
        // Keine Exploit-Details, keine Fremd-Payload in der Meldung.
        assert.ok(err.message.length <= 200, "Fehlermeldung bleibt knapp");
        return true;
      },
      `verwundbare Version akzeptiert: ${String(unsafe)}`,
    );
  }
  for (const safe of [MIN_WS_VERSION, "8.21.3", "8.22.0", "9.0.0"]) {
    assertPatchedWsVersion(safe);
  }
});

test("SEC-04: die installierte ws-Laufzeit erfuellt den Floor", () => {
  const runtime = loadWsRuntime();
  assertPatchedWsVersion(runtime.version);
  assert.equal(typeof runtime.WebSocket, "function");
});

test("SEC-04: Client-Optionen kappen Speicher und Handshake hart", () => {
  const options = wsClientOptions();
  assert.ok(Number.isSafeInteger(options.maxPayload) && options.maxPayload > 0, "maxPayload muss gesetzt sein");
  assert.equal(options.maxPayload, WS_MAX_PAYLOAD_BYTES);
  // Deutlich unter dem ws-Default (100 MiB) — Marktdaten sind wenige KiB gross.
  assert.ok(options.maxPayload <= 1024 * 1024, "maxPayload zu grosszuegig");
  assert.equal(options.perMessageDeflate, false, "Kompression waere Speicher-Amplifikation");
  assert.equal(options.skipUTF8Validation, false, "UTF-8-Validierung darf nicht abgeschaltet sein");
  assert.equal(options.followRedirects, false, "Redirects wuerden die Host-Allowlist umgehen");
  assert.ok(options.handshakeTimeout > 0 && options.handshakeTimeout <= 30_000, "Handshake muss begrenzt sein");
});

test("SEC-04: openHardenedWs oeffnet keinen Socket auf verwundbarer Laufzeit", () => {
  let constructed = 0;
  const vulnerable: WsRuntime = {
    version: "8.18.0",
    WebSocket: class {
      constructor() {
        constructed += 1;
      }
    } as unknown as WsRuntime["WebSocket"],
  };
  assert.throws(() => openHardenedWs("wss://fapi.bitunix.com/public/", vulnerable), BitunixApiError);
  assert.equal(constructed, 0, "Socket wurde trotz verwundbarer Laufzeit erzeugt");
});

test("SEC-04: openHardenedWs reicht die gehaerteten Optionen an ws durch", () => {
  const seen: Array<{ url: string; options: unknown }> = [];
  const patched: WsRuntime = {
    version: "8.21.3",
    WebSocket: class {
      constructor(url: string, options: unknown) {
        seen.push({ url, options });
      }
      send(): void {}
      close(): void {}
    } as unknown as WsRuntime["WebSocket"],
  };
  const socket = openHardenedWs("wss://fapi.bitunix.com/public/", patched);
  assert.ok(socket, "Socket erwartet");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "wss://fapi.bitunix.com/public/");
  assert.deepEqual(seen[0].options, wsClientOptions());
});

test("SEC-04: Fragment-Flut eines boesartigen Endpunkts wird gekappt statt gepuffert", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  const fragment = Buffer.alloc(64_000, 0x61);
  const fragments = Math.ceil(WS_MAX_PAYLOAD_BYTES / fragment.length) + 4;
  let written = 0;
  server.on("connection", (peer: NodeWebSocket) => {
    // Roh geschriebene Frames: eine nie beendete Text-Nachricht aus vielen
    // kleinen Fortsetzungs-Fragmenten (Angriffsmuster CVE-2026-48779).
    const raw = (peer as unknown as { _socket: Socket })._socket;
    raw.write(frame(false, 0x1, fragment));
    written += fragment.length;
    for (let i = 0; i < fragments; i += 1) {
      raw.write(frame(false, 0x0, fragment));
      written += fragment.length;
    }
  });

  const errors: Error[] = [];
  let reconnects = 0;
  let messages = 0;
  const client = new BitunixPublicWs({
    config: cfg(port),
    handlers: {
      onError: (e) => errors.push(e),
      onReconnect: () => {
        reconnects += 1;
      },
      onTicker: () => {
        messages += 1;
      },
    },
    // Reconnect wird angestossen, aber nie ausgefuehrt: stop() raeumt den Timer.
    backoff: () => 60_000,
  });

  const closed = new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 10_000);
    const poll = setInterval(() => {
      if (reconnects > 0) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    }, 10);
    timer.unref?.();
    poll.unref?.();
  });

  await client.start();
  await closed;
  client.stop();
  server.close();
  await once(server, "close");

  assert.ok(written > WS_MAX_PAYLOAD_BYTES, "Testaufbau muss die Kappe ueberschreiten");
  assert.ok(reconnects > 0, "Verbindung haette wegen Ueberschreitung schliessen muessen");
  assert.ok(errors.length > 0, "Kappen-Verletzung muss als Fehler gemeldet werden");
  assert.equal(messages, 0, "keine Nutzdaten aus der Flut");
  assert.equal(client.tickers.size, 0, "kein Ticker-State aus der Flut");
});

test("SEC-04: stop() schliesst ohne Code/Reason-Puffer", () => {
  const calls: unknown[][] = [];
  const fake: WsLike = {
    send: () => {},
    close: (...args: unknown[]) => {
      calls.push(args);
    },
    addEventListener: () => {},
  };
  const client = new BitunixPublicWs({ config: cfg(9), open: () => fake });
  void client.start();
  client.stop();
  assert.equal(calls.length, 1, "close() muss genau einmal aufgerufen werden");
  // CVE-2026-45736 betrifft close() mit Reason-Argument; hier bewusst ohne.
  assert.deepEqual(calls[0], [], "close() darf keine Reason-Argumente uebergeben");
});
