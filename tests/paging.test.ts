import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  normalizePage,
  normalizePageSize,
  pageCount,
  pageOffset,
  pageWindow,
  slicePage,
} from "../src/lib/paging";

const rows = Array.from({ length: 137 }, (_, index) => index + 1);

test("Paging: Seitengrößen sind genau 20/50/100/200, Default 20", () => {
  assert.deepEqual([...PAGE_SIZE_OPTIONS], [20, 50, 100, 200]);
  assert.equal(DEFAULT_PAGE_SIZE, 20);
  assert.equal(MAX_PAGE_SIZE, 200);
  assert.equal(normalizePageSize(undefined), 20);
  assert.equal(normalizePageSize("abc"), 20);
  assert.equal(normalizePageSize(Number.NaN), 20);
  assert.equal(normalizePageSize(-5), 20);
  // Nicht erlaubte Werte fallen auf den Default statt einen SQL-Fehler zu bauen.
  assert.equal(normalizePageSize(37), 20);
  assert.equal(normalizePageSize("100"), 100);
  assert.equal(normalizePageSize(200), 200);
});

test("Paging: ab 21 Einträgen gibt es mehr als eine Seite", () => {
  assert.equal(pageCount(20, 20), 1);
  assert.equal(pageCount(21, 20), 2);
  assert.equal(pageCount(137, 20), 7);
  assert.equal(pageCount(137, 100), 2);
  // Leere Liste: Seite 1 von 1, damit die UI keinen unmöglichen Stand zeigt.
  assert.equal(pageCount(0, 20), 1);
});

test("Paging: Seitenschnitt liefert exakt das Anzeigefenster", () => {
  assert.equal(slicePage(rows, 1, 20).length, 20);
  assert.deepEqual(slicePage(rows, 2, 20), rows.slice(20, 40));
  assert.deepEqual(slicePage(rows, 7, 20), rows.slice(120, 137));
  // Seite außerhalb des Bereichs wird geklemmt, nicht leer geliefert.
  assert.deepEqual(slicePage(rows, 99, 20), rows.slice(120, 137));
  assert.deepEqual(slicePage(rows, 0, 20), rows.slice(0, 20));
});

test("Paging: Anzeigefenster '21–40 von 137'", () => {
  assert.deepEqual(pageWindow(137, 2, 20), { from: 21, to: 40, total: 137 });
  assert.deepEqual(pageWindow(137, 7, 20), { from: 121, to: 137, total: 137 });
  assert.equal(pageWindow(0, 1, 20), null);
});

test("Paging: Seitenzahl klemmt und Offset ist nie negativ", () => {
  assert.equal(normalizePage(0, 7), 1);
  assert.equal(normalizePage(99, 7), 7);
  assert.equal(normalizePage(Number.NaN, 7), 1);
  assert.equal(pageOffset(1, 20), 0);
  assert.equal(pageOffset(3, 50), 100);
  assert.equal(pageOffset(-2, 50), 0);
});
