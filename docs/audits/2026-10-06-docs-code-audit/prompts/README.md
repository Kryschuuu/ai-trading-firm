# Prompts — Docs↔Code-Audit 2026-10-06

> **Konvention (siehe auch `remediation/TRACKING.md`):** **ein Prompt = eine
> Coding-Session.** Prompt in eine neue Session kopieren, Ergebnis committen,
> Status in `../remediation/TRACKING.md` auf ☑ setzen.
> Jeder Prompt ist so geschrieben, dass er ohne Kontext aus dieser Audit-Session
> funktioniert (Fundstellen, erwartetes Ergebnis, Verifikationskommandos).

| Prompt | Befund | Severity | Titel | Reihenfolge |
|--------|--------|----------|-------|-------------|
| [DC-04](PROMPT-DC-04-versions-header-bump.md) | [DC-04](../findings/DC-04-versions-header-drift.md) | MEDIUM | Versions-/Status-Header klassifizieren und auf Code-Stand bringen | 1 |
| [DC-05](PROMPT-DC-05-env-flags-entscheiden.md) | [DC-05](../findings/DC-05-env-flags-ohne-implementierung.md) | MEDIUM | Env-Flags: implementieren oder streichen; `.env.example`/`CONFIGURATION.md` angleichen | 2 |
| [DC-06](PROMPT-DC-06-symbol-pfad-abgleich.md) | [DC-06](../findings/DC-06-symbol-und-pfad-drift.md) | MEDIUM | Symbol-/Pfad-Drift in `PIPELINE_MAP.md`/`INTEGRATION_POINTS.md` korrigieren | 3 |
| [DC-07](PROMPT-DC-07-db-schema-nachfuehren.md) | [DC-07](../findings/DC-07-db-schema-15-von-67.md) | MEDIUM | `DB_SCHEMA.md` nachführen (generiertes Schema-Inventar) | 4 |
| [DC-08](PROMPT-DC-08-docs-validate-ausbau.md) | [DC-08](../findings/DC-08-ci-waechter-luecken.md) | MEDIUM | `docs:validate` um die fünf fehlenden Prüfungen erweitern | 5 (nach DC-04…DC-07) |
| [DC-09](PROMPT-DC-09-inventare-und-release-bump.md) | [DC-09](../findings/DC-09-prozess-inventare-und-bump.md) | LOW | Generierte Inventare + Release-Bump-Skript | 6 (kann DC-07/DC-08 vorbereiten) |

**Bereits erledigt (kein Prompt nötig):** DC-01 (Proposal-Freigabe ohne
Autorisierung) und DC-02 (`REQUIRE_HUMAN_APPROVAL`) wurden 2026-10-06 direkt
gefixt — Nachweise in den jeweiligen Findings und in `../../../../CHANGELOG.md`.

## Warum diese Reihenfolge?

1. **DC-04** stellt die *Sichtbarkeit* her (welches Dokument beschreibt welchen
   Stand) — ohne das ist jede weitere Aussage „dokumentiert" schwer prüfbar.
2. **DC-05/DC-06/DC-07** sind inhaltliche Nachführungen; sie liefern die
   Wahrheitslisten, die DC-08 anschließend als Checks festschreibt.
3. **DC-08** darf erst greifen, wenn die Doku stimmt — sonst macht der
   verschärfte Wächter bestehende PRs rot.
4. **DC-09** ist der dauerhafte Mechanismus (Inventare + Bump) und kann
   parallel zu DC-07/DC-08 begonnen werden.
