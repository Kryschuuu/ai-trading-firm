# SEC-10 — GitHub Actions nicht auf immutable SHAs gepinnt

- **ID:** SEC-10
- **Severity:** LOW
- **Bereich:** CI / Supply Chain
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-10 — GitHub Actions nicht auf immutable SHAs gepinnt
- **Status:** OPEN
- **Fix-Version:** -
- **Datei(en):** `.github/workflows/main.yml`, `.github/workflows/main-security-live-gatte.yml`
- **Peer-Review-Patch:** TBD — verlinken sobald Patch in `docs/peer-reviews/` existiert

## Beschreibung

Die CI verwendet mutable Action-Tags:

```yaml
uses: actions/checkout@v4
uses: actions/setup-node@v4
uses: actions/upload-artifact@v4
```

Tags wie `@v4` sind bewegliche Referenzen. Ein kompromittiertes bzw. nachträglich verschobenes Tag könnte theoretisch Code in der CI ausführen (Supply-Chain-Angriff auf den Runner).

Positiv ist bereits:

```yaml
permissions:
  contents: read
```

Die Workflows haben also eine sinnvolle minimale Token-Berechtigung. Es liegt **kein direkter Exploit** vor — das Finding ist Supply-Chain-Hardening.

## Beweis / PoC

```bash
rg -n "uses: actions/" .github/workflows/
# .github/workflows/main.yml
#   uses: actions/checkout@v4
#   uses: actions/setup-node@v4
# .github/workflows/main-security-live-gatte.yml
#   uses: actions/checkout@v4
#   uses: actions/setup-node@v4
#   uses: actions/upload-artifact@v4
```

Erwartet (gehärtet): `uses: actions/checkout@<40-hex-SHA>` mit Kommentar zum Tag.  
Tatsächlich: floating major tags.

## Remediation (aus Audit + eigene Bewertung)

1. Actions auf **vollständige Commit-SHAs** pinnen:
   ```yaml
   uses: actions/checkout@<vollständige-Commit-SHA> # v4.x.x
   uses: actions/setup-node@<vollständige-Commit-SHA> # v4.x.x
   uses: actions/upload-artifact@<vollständige-Commit-SHA> # v4.x.x
   ```
2. Renovate oder Dependabot nutzen, um diese SHAs kontrolliert zu aktualisieren (nicht manuell „ewig“ einfrieren).
3. `permissions: contents: read` beibehalten; keine Ausweitung ohne Begründung.

## Akzeptanzkriterien / Tests

- [ ] Kein `uses: actions/*@vN` ohne SHA in `.github/workflows/`
- [ ] Jede gepinnte Action hat einen Kommentar mit Tag/Version
- [ ] Dependabot/Renovate für GitHub Actions aktiv oder Update-Prozess dokumentiert
- [ ] `permissions:` bleibt least-privilege
- [ ] CI (`docs-validate`, `security-live-gate`) bleibt grün

## Changelog-Blurb

```
SEC-10 (LOW): GitHub Actions auf immutable Commit-SHAs gepinnt
```

## Versions-Hinweis

PATCH, Supply-Chain-Hardening.
