# VBF-engine-default — Engine-Default bleibt legacy

- **Status:** WONTFIX (bewusst gesperrt)

## Befund

`runMultiAssetBacktest` defaultet auf `executionModel: "legacy"`, damit
bestehende Läufe byte-gleich bleiben. Der Paper-Pfad ist Opt-in der
Walk-Forward-CLI und — seit v0.2.0 — Default nur der Regel-Route.

## Entscheidung

Kein Prompt, der den Engine-Default umstellt.
