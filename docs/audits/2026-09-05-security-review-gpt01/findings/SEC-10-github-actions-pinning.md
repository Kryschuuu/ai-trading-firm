# SEC-10 — GitHub Actions nicht auf immutable SHAs gepinnt

- **ID:** SEC-10
- **Severity:** LOW
- **Bereich:** CI / Supply Chain
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-10 — GitHub Actions nicht auf immutable SHAs gepinnt
- **Status:** FIXED
- **Fix-Version:** 1.36.29
- **Datei(en):** `.github/workflows/main.yml`, `.github/workflows/security-live-gate.yml`
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
   uses: actions/checkout@<vollständige-Commit-SHA> # v7.0.1
   uses: actions/setup-node@<vollständige-Commit-SHA> # v7.0.0
   uses: actions/upload-artifact@<vollständige-Commit-SHA> # v7.0.1
   ```
2. Renovate oder Dependabot nutzen, um diese SHAs kontrolliert zu aktualisieren (nicht manuell „ewig“ einfrieren).
3. `permissions: contents: read` beibehalten; keine Ausweitung ohne Begründung.

**Umgesetzt in v1.36.29:** Alle drei Actions auf die aktuellen Releases
(checkout v7.0.1, setup-node v7.0.0, upload-artifact v7.0.1) inkl. Tag-Kommentar
gepinnt; `.github/dependabot.yml` (Ökosystem `github-actions`, wöchentlich,
gruppierte PRs) übernimmt die kontrollierten SHA-Updates. Zusätzlich erzwungen:
Spiegel-Sync-Schritt (`docs/ci/` == `.github/workflows/`) und fail-closed
`npm audit --audit-level=high` im Security-Gate. Der Mirror
`main-security-live-gatte.yml` (Tippfehler im Namen) wurde nach
`security-live-gate.yml` umbenannt — der Ziel-Pfad, den `scan-live-gate-secrets.ts`
und `docs/LIVE_TRADING.md` §8 bereits erwarteten.

## Akzeptanzkriterien / Tests

- [x] Kein `uses: actions/*@vN` ohne SHA in `.github/workflows/`
- [x] Jede gepinnte Action hat einen Kommentar mit Tag/Version
- [x] Dependabot/Renovate für GitHub Actions aktiv oder Update-Prozess dokumentiert
- [x] `permissions:` bleibt least-privilege
- [x] CI (`docs-validate`, `security-live-gate`) bleibt grün

## Changelog-Blurb

```
SEC-10 (LOW): GitHub Actions auf immutable Commit-SHAs gepinnt
```

## Versions-Hinweis

PATCH, Supply-Chain-Hardening.
