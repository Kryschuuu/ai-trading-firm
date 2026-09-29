# STX-16 — Copy-Trading verschiebt das Compliance-/Haftungsprofil

- **ID:** STX-16
- **Severity:** LOW (organisatorisch hoch)
- **Bereich:** Organisation / Produkt
- **Quelle:** Ausbaudokument §2 (kein Abschnitt dazu)
- **Status:** OPEN
- **Datei(en):** `README.md`, `package.json` (`description`)

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
