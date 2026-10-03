# STX-16 — Copy-Trading verschiebt das Compliance-/Haftungsprofil

- **ID:** STX-16
- **Severity:** LOW (organisatorisch hoch)
- **Bereich:** Organisation / Produkt
- **Quelle:** Ausbaudokument §2 (kein Abschnitt dazu)
- **Status:** FIXED — Abgleich 2026-10-03: Phase 7 ausschließlich `SIMULATE_ONLY` umgesetzt (07-01 `b0bfcce`, 07-02 `f5af325`, 07-03 `5f437d8`)
- **Datei(en):** `README.md`, `package.json` (`description`)

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `☑` **FIXED** — von `OPEN` hochgestuft (technische Kriterien; rechtliche Prüfung bleibt außerhalb des Repos)
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- `src/copy/types.ts:32` — `export type CopyMode = "SIMULATE_ONLY";`; `:39` — `export const COPY_MODES: readonly CopyMode[] = ["SIMULATE_ONLY"];` (Enum mit **einem** Wert, keine Konstante)
- Datenbankebene: `drizzle/2026-10-03_copy_subscriptions.sql:39` — `CHECK (mode = 'SIMULATE_ONLY')`, zusätzlich `enabled=false` als Default
- Kein Live-Follower-Pfad: `src/copy/follower/simulated.ts:14` („keinen `BrokerAdapter`, keinen Venue-Order-Pfad"), Füllung ausschließlich über `PaperBroker.submit()`/`close()` (`:360`)
- Test `tests/copy.engine.test.ts` ausgeführt: **20 Tests, 0 Fehler** — enthält die Baseline-Reihenfolge, Heartbeat-Pause, Doppelzustellung und `HALTED`-Blockade
- **Offen bleibt** [OP-4](../remediation/TRACKING.md#offene-punkte-für-den-reviewer): die rechtliche Prüfung für einen möglichen späteren Live-Betrieb liegt außerhalb dieses Repos

## Beschreibung

Das Copy-Trading-Kapitel behandelt ausschließlich Technik (Symbol-Mapping, Leverage,
Slippage). Es berührt nicht die Rechtsfrage, die mit „fremde Positionen gegen Entgelt
spiegeln" verbunden ist.

## Beweis

`package.json`:

> „Autonome KI-Trading-Firma (Paper-Trading) — BETA (v0.x), nicht produktionsreif.
> Local-first … Educational purposes only, use at your own risk."

Die Positionierung ist **bewusst** restriktiv. Ein Copy-Engine verändert den Charakter:
Nicht mehr „die Firma handelt für sich", sondern „die Firma handelt für Dritte".

## Remediation

1. Phase 7 **ausschließlich** als Paper-/Simulation mit `copyMode: "SIMULATE_ONLY"`,
   hart verdrahtet und nicht per Env-Flag in Live umschaltbar.
2. Kein „go live"-Pfad in dieser Roadmap.
3. Vor jedem Ausbau über Live-Copy: separate Rechts-/Compliance-Prüfung, die **nicht**
   Teil dieses Repos ist.

## Akzeptanzkriterien

- [ ] Kein Code-Pfad im Copy-Modul kann eine Live-Follower-Order erzeugen
- [ ] `SIMULATE_ONLY` ist keine Konstante, sondern ein Enum mit **einem** Wert

## Versions-Hinweis

N/A.
