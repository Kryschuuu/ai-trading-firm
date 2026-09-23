# VBF-live-exit — detectExit nicht ersetzen

- **Status:** WONTFIX (bewusst gesperrt)

## Befund

`detectExit` ist der Live-/Paper-Monitor. Ihn durch `detectExitTrigger` zu
ersetzen würde offene Positionen anders schließen, ohne dass der
Paritätstest das verlangt.

## Entscheidung

Nur der Test (VBF-P3-01). Kein Verhaltenswechsel.
