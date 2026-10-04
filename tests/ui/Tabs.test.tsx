/**
 * Reiter schalten den sichtbaren Bereich um (v0.16.1).
 *
 * Vorher renderten Dashboard und Workshop jedes `TabPanel` ohne `active`.
 * Ein Klick setzte nur `aria-selected`; alle Bereiche blieben untereinander
 * auf einer Seite. Der Vertrag ist jetzt:
 *
 *   1. `selectDashboardTab` akzeptiert nur die neun Dashboard-IDs,
 *   2. `tabPanelVisibility` nimmt inaktive Panels aus dem Layout,
 *   3. das gerenderte Markup trägt `hidden` und `display: none`,
 *   4. Dashboard und Workshop übergeben `active` an jedes Panel.
 *
 * Ohne Browser (`renderToStaticMarkup`), wie die übrigen UI-Tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { DASHBOARD_TAB_IDS, selectDashboardTab } from "../../src/components/dashboardTabs";
import { TabPanel, tabPanelVisibility } from "../../src/components/ui/Tabs";

const ROOT = path.resolve(import.meta.dirname, "../..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

test("selectDashboardTab wechselt nur auf eine bekannte Reiter-ID", () => {
  assert.equal(selectDashboardTab("overview", "reports"), "reports");
  assert.equal(selectDashboardTab("reports", "architecture"), "architecture");
  assert.equal(selectDashboardTab("ops", "overview"), "overview");
  // Unbekannte Sprünge (alte Links, Tippfehler) lassen den Bereich stehen.
  assert.equal(selectDashboardTab("brokers", "settings"), "brokers");
  assert.equal(selectDashboardTab("risk", ""), "risk");
  assert.equal(selectDashboardTab("protocol", "PROTOCOL"), "protocol");
});

test("inaktives Panel ist aus dem Layout, aktives nicht", () => {
  const hidden = tabPanelVisibility(false);
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.inert, true);
  assert.equal(hidden.tabIndex, -1);
  assert.equal(hidden.style?.display, "none");
  assert.match(hidden.className, /\bhidden\b/);

  const shown = tabPanelVisibility(true);
  assert.equal(shown.hidden, undefined);
  assert.equal(shown.inert, undefined);
  assert.equal(shown.style, undefined);
  assert.equal(shown.tabIndex, 0);
  assert.doesNotMatch(shown.className, /\bhidden\b/);
});

test("gerendertes Panel: nur der gewählte Bereich ist sichtbar", () => {
  for (const active of DASHBOARD_TAB_IDS) {
    const html = DASHBOARD_TAB_IDS.map((id) =>
      renderToStaticMarkup(
        <TabPanel id={id} active={active === id}>
          <p>{`inhalt-${id}`}</p>
        </TabPanel>,
      ),
    ).join("");

    const visible = html.match(/role="tabpanel"(?![^>]*\shidden=)/g) ?? [];
    assert.equal(visible.length, 1, `${active}: genau ein sichtbares Panel`);
    assert.match(html, new RegExp(`id="tab-panel-${active}"(?![^>]*\\shidden=)`));
    assert.match(html, new RegExp(`id="tab-panel-${active}"[^>]*>\\s*<p>inhalt-${active}</p>`));

    for (const id of DASHBOARD_TAB_IDS) {
      if (id === active) continue;
      assert.match(
        html,
        new RegExp(`id="tab-panel-${id}"[^>]*\\shidden=""`),
        `${id} muss hidden sein, wenn ${active} gewählt ist`,
      );
      assert.match(
        html,
        new RegExp(`id="tab-panel-${id}"[^>]*style="display:none"`),
        `${id} darf keinen Platz einnehmen, wenn ${active} gewählt ist`,
      );
    }
  }
});

test("Dashboard bindet jedes Panel an den gewählten Reiter", () => {
  const src = read("src/components/FirmDashboard.tsx");
  assert.match(src, /onChange=\{selectTab\}/);
  assert.doesNotMatch(src, /onChange=\{setTab\}/);
  assert.match(src, /setTab\(\(current\) => selectDashboardTab\(current, next\)\)/);
  for (const id of DASHBOARD_TAB_IDS) {
    assert.ok(
      src.includes(`<TabPanel id="${id}" active={tab === "${id}"}>`),
      `Panel ${id} ist nicht an den gewählten Reiter gebunden`,
    );
  }
  // Lade-Skelett zeigt den bereits gewählten Reiter, nicht alle Bereiche.
  assert.match(src, /<TabPanel id=\{tab\} idPrefix="tab" active>/);
});

test("Workshop-Schritte sind ebenfalls ein Reiter, nicht eine Stapelung", () => {
  const src = read("src/components/workshop/WorkshopTab.tsx");
  for (const id of ["missions", "run", "prompt", "hitrate", "rulebacktest"]) {
    assert.ok(
      src.includes(`active={step === "${id}"}`),
      `Workshop-Schritt ${id} ohne active-Bindung`,
    );
  }
});
