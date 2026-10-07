# Bericht — Docs↔Code-Audit 2026-10-06 (Kurzfassung)

Der **Volltext** des Audits steht unter
[`../../DOCS_CODE_AUDIT_2026-10-06.md`](../../DOCS_CODE_AUDIT_2026-10-06.md)
(§0 Auftrag/Methodik, §1 Kurzfassung, §2 Prüfbasis, §3 Befunde, §4 technische
Beobachtungen, §5 Vollständigkeit, §6 Maßnahmen, §7 Reproduktionskommandos).

Diese Datei ist die **Kurzfassung für den Audit-Ordner** und wird mit dem
Tracking ([`remediation/TRACKING.md`](remediation/TRACKING.md)) aktuell gehalten.

## Ergebnis in vier Sätzen

1. Die Doku ist umfangreich und in den Kernbereichen (Live-Gate-Zustandsmaschine,
   Scanner-Faktoren/-Gewichte, 25 Regelfelder, API-Routenmenge,
   Kill-Switch-Persistenz, Changelog-Testzahlen) nachweislich korrekt;
   `typecheck`, `lint` und `docs:validate` sind grün.
2. Die verbleibende Drift liegt systematisch dort, wo der eigene Wächter
   `docs:validate` **nicht** prüft: Versions-Header (4/45 aktuell),
   Mengenangaben (15/67 Tabellen, „3 Features"), Env-Flags ohne Code-Read (4),
   Symbol-/Pfad-Referenzen ohne Entsprechung (10).
3. Ein sicherheitsrelevanter Fund (Proposal-Freigabe ohne Autorisierung) und ein
   Konsistenzfund (`REQUIRE_HUMAN_APPROVAL` mit zwei Semantiken) wurden direkt
   behoben und mit Regressionstests festgehalten (DC-01, DC-02).
4. Die Ursache der restlichen Drift ist prozessual und mit sechs kopierfertigen
   Prompts adressiert (DC-04…DC-09), deren Reihenfolge in
   `prompts/README.md` begründet ist.

## Zahlen des Prüflaufs (2026-10-06, Node v22.22.3)

| Metrik | Wert |
|--------|------|
| `docs/`-Markdown-Dateien | 338 (rund 54.800 Zeilen) |
| Dokumentierte API-Routen | 87 `route.ts` / 16 Namespaces |
| Drizzle-Tabellen | 67 `pgTable`, 0 `pgEnum` |
| Drizzle-Migrationen | 34 |
| Versions-Header auf Code-Stand | 4 von 45 |
| `npm test` ohne externe DB | 4.760 Tests · 4.722 pass · 2 fail · 36 skip (2 DB-bedingte Contract-Tests) |
