/**
 * STX-08-05 / STX-21 — lokale Endpunkt-Klassifikation.
 *
 * Die Prüfung ist rein und deterministisch: nur die literale Host-Prüfung des
 * übergebenen Strings, kein DNS, kein Socket. Getestet werden die zugesagten
 * Loopback-Formen, `localhost`, die reservierten Testnamensräume sowie die
 * fail-closed-Fälle (öffentliche Domains, private Netze, Kurznamen,
 * Credentials, Fremdschemata, Unparsebares).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isLocalEndpointBaseUrl,
  isLocalHostLiteral,
} from "../src/routing/localEndpoint";

test("Loopback-IPv4 (127.0.0.0/8) und localhost gelten als lokal", () => {
  for (const url of [
    "http://127.0.0.1:11434",
    "http://127.0.0.1:8080/v1",
    "http://127.0.0.2:9999/v1",
    "https://127.255.255.254/v1",
    "http://127.1/", // URL-Normalisierung → 127.0.0.1
    "http://localhost:11434",
    "http://localhost:8080/v1",
    "http://LOCALHOST/v1",
    "http://api.localhost/v1", // RFC 6761: *.localhost zeigt auf Loopback
  ]) {
    assert.equal(isLocalEndpointBaseUrl(url), true, `${url} muss lokal sein`);
  }
});

test("IPv6-Loopback ::1 (auch gemappt/ausgeschrieben/geklammert) gilt als lokal", () => {
  for (const url of [
    "http://[::1]:11434",
    "http://[::1]/v1",
    "http://[0:0:0:0:0:0:0:1]:11434/v1",
    "http://[::ffff:127.0.0.1]:8080/v1", // von new URL() zu [::ffff:7f00:1] normalisiert
  ]) {
    assert.equal(isLocalEndpointBaseUrl(url), true, `${url} muss lokal sein`);
  }
  assert.equal(isLocalHostLiteral("::1"), true);
  assert.equal(isLocalHostLiteral("[::1]"), true);
  assert.equal(isLocalHostLiteral("0:0:0:0:0:0:0:1"), true);
  assert.equal(isLocalHostLiteral("::ffff:7f00:1"), true);
});

test("reservierte, öffentlich nicht auflösbare Namensräume (.test/.invalid) gelten als lokal", () => {
  assert.equal(isLocalEndpointBaseUrl("http://ollama.test:11434"), true);
  assert.equal(isLocalEndpointBaseUrl("http://lm-studio.test:8080/v1"), true);
  assert.equal(isLocalEndpointBaseUrl("https://host.invalid/v1"), true);
  assert.equal(isLocalHostLiteral("OLLAMA.TEST"), true);
});

test("Cloud-/öffentliche Endpunkte sind nicht lokal", () => {
  for (const url of [
    "https://api.openai.com/v1",
    "https://generativelanguage.googleapis.com/v1beta",
    "https://api.anthropic.com/v1",
    "https://opencode.ai/zen/v1",
    "http://ollama.example.com:11434", // .example.com ist öffentlich (RFC 2606 nur reservierter Name)
    "https://ollama.test.example.com/v1", // endet auf .com, nicht auf .test
  ]) {
    assert.equal(isLocalEndpointBaseUrl(url), false, `${url} darf nicht lokal sein`);
  }
});

test("private Netze, Kurznamen und andere Adressen sind fail-closed nicht lokal", () => {
  for (const url of [
    "http://192.168.1.50:8080/v1", // privates Netz, aber kein Loopback
    "http://10.0.0.5:11434",
    "http://172.16.0.9:11434",
    "http://ollama:11434", // Container-/Intranet-Kurzname ohne Punkt
    "http://llm:9999/v1",
    "http://127.0.0.300:8080/v1",
    "http://127.0.0.1.evil.example/v1",
    "http://128.0.0.1/v1",
  ]) {
    assert.equal(isLocalEndpointBaseUrl(url), false, `${url} darf nicht lokal sein`);
  }
});

test("Fremdschemata, Credentials, Leerwerte und Unparsebares sind nicht lokal", () => {
  for (const url of [
    "ftp://127.0.0.1/v1",
    "file:///etc/passwd",
    "http://user:secret@127.0.0.1:8080/v1",
    "not a url",
    "",
    "   ",
  ]) {
    assert.equal(isLocalEndpointBaseUrl(url), false, `${JSON.stringify(url)} darf nicht lokal sein`);
  }
  assert.equal(isLocalEndpointBaseUrl(undefined), false);
  assert.equal(isLocalEndpointBaseUrl(null), false);
  assert.equal(isLocalHostLiteral(""), false);
  assert.equal(isLocalHostLiteral("localhost.evil.example"), false);
  assert.equal(isLocalHostLiteral("notlocalhost"), false);
});
