# SEC-03 — Verwundbare Next.js-Version

- **ID:** SEC-03
- **Severity:** HIGH
- **Bereich:** Dependencies / Supply Chain
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-03 — Verwundbare Next.js-Version
- **Status:** FIXED (2026-09-06)
- **Fix-Version:** 1.36.28
- **Betroffener Projektstand:** v1.36.27 mit Next.js 16.3.1; weitere Installationen gemäß Upstream-Versionsbereichen prüfen
- **Datei(en):** `package.json`, `package-lock.json`, `tests/sec03.nextDependencies.test.ts`, `tests/sec03.nextBoundaries.test.ts`, Security-Workflow und dessen Quelle unter `docs/ci/`; zugehörige Release-/Upgrade-Dokumentation
- **Fix-Commit:** [25dcc8b](https://github.com/Kryschuuu/ai-trading-firm/commit/25dcc8bbe8ef309c8b735c40573e06110058906d)
- **Red-Test-Commit:** [00d7ee0](https://github.com/Kryschuuu/ai-trading-firm/commit/00d7ee0579e81c6368c4253fde51c662a04d5e4d)

## Ursprünglicher Befund und Root Cause

Im geprüften Projektstand war `next` mit `^16.3.1` deklariert. Nicht nur die
Range erlaubte eine verwundbare Installation: Der konkrete Lockfile-Eintrag
`node_modules/next` löste tatsächlich **16.3.1** auf. Ein verbindliches Gate
für Framework- und Decoder-Versionen fehlte.

Am **25. August 2026** veröffentlichte Upstream zwei kritische RCE-Advisories:

- [GHSA-p293-qw3h-jr36 / CVE-2026-75604](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36):
  im hier genutzten Major betroffen `>=16.0 <16.3.3`, behoben in **16.3.3**,
  CVSS 9.0. Pages-/App-Router ohne Cache Components auf Windows-Dateisystemen.
- [GHSA-2xp9-vwfh-vxw4](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4):
  im hier genutzten Major betroffen `<16.3.3`, Mindestfix **16.3.3**, CVSS 9.5.
  Die native AVIF-Verarbeitung über `sharp`/`libheif` ist betroffen.

### Angriffsfläche und Vertrauensgrenzen

- Unauthentifizierte Framework-Requests liegen außerhalb der fachlichen
  Auth-/RBAC-Guards. Windows-Pfadsemantik und nicht ausreichend begrenzte
  Cache-Dateipfade dürfen daher nicht durch API-Login als geschützt gelten.
- Die App nutzt den App Router ohne aktivierte Cache Components. Das Linux-/
  systemd-Deployment reproduziert den Windows-RCE-Pfad nicht unmittelbar;
  Windows wird aber ebenfalls über einen eigenen Installer unterstützt.
- Der Image-Optimizer ist ein separater Framework-Pfad. Ein fehlender
  `next/image`-Import entfernt ihn nicht. Remote-Quellen sind aktuell nicht
  freigegeben, lokale Quellen dagegen schon. Weder Dateiendung noch ein
  mitgelieferter MIME-Typ sind eine vertrauenswürdige Decoder-Grenze.
- Root Cause ist der ausgelieferte verwundbare Framework-/Native-Code, nicht
  eine einzelne Anwendungsroute. Linux, CSP, Auth und reine UI-Änderungen sind
  kein vollständiger Ersatz für das Dependency-Update.

### Beweis am Ausgangsstand

```json
"next": "^16.3.1"
```

`npm ci` installierte Next.js **16.3.1**, sharp **0.35.3** und libheif **1.23.1**.
Die neuen Tests scheiterten vor dem Update an den Versions- und tatsächlichen
Framework-Grenzen; hierfür wurden keine RCE-Dateien oder echten Secrets benutzt.

## Implementierter Fix (v1.36.28)

- Exakter stabiler Pin **`next: 16.3.4`**, regeneriertes Lockfile mit korrekten
  Registry-Artefakten/Integritätswerten und passenden `@next/env`-/SWC-Paketen
  für alle Plattformen. Kein manuelles Austauschen nur der Versionsstrings.
- **Native Kette mitgepatcht:** sharp **0.35.4**, zugehörige libvips-Pakete
  **1.3.3**, geladene libheif-Library **1.23.2**. Die vorhandene Script-Freigabe
  für sharp folgt der neuen Version.
- Wichtig: **16.3.3 deaktivierte AVIF vorübergehend**. Der stabile Folgepatch
  [16.3.4](https://github.com/vercel/next.js/releases/tag/v16.3.4) aktiviert es
  mit gepatchtem Decoder wieder. Nur Next zu prüfen wäre deshalb unvollständig.
  Native Referenz: [GHSA-g89c-p67h-r497](https://github.com/strukturag/libheif/security/advisories/GHSA-g89c-p67h-r497).
- `npm run test:security:next` prüft exakten stabilen Pin, sämtliche relevanten
  Lockfile-Pakete einschließlich verschachtelter/anderer Plattform-Kopien,
  tatsächlich aufgelöstes Next/sharp und die **geladene libheif-Version**.
  Auch fehlende/veraltete Custom-Libraries und Drift nach unvollständigem Update
  werden abgelehnt. Keine neue direkte Abhängigkeit oder neue App-Architektur.
- Die Suite läuft vor Auth/Live-Gate unter Linux und zusätzlich in
  `security-next-windows`. Der Required Check `security-live-gate` hängt vom
  Windows-Job ab und verlangt zusätzlich einen erfolgreichen Produktions-Build.
  Ein fehlgeschlagener Windows-Test verhindert auch den Security-Suite-Stamp.

## Regressionen und Validierung

- **Rot vor Fix:** **15/25** Tests scheiterten mit unveränderten Dependencies.
  Nach dem Manifest-/Lockfile-Update, aber noch mit alter Installation,
  scheiterten weiterhin die beiden Runtime-/Decoder-Prüfungen.
- **Grün nach Fix:** **26/26** SEC-03-Tests ohne Skips, einschließlich der
  zusätzlichen Prüfung der verbindlichen Security-Gate-Verdrahtung.
- Cache-Reads und -Writes werden über das echte installierte Framework mit
  einem aufzeichnenden Fake-FS geprüft: App-Pages, App-Routen, Pages, Fetch und
  Image-Reads; Traversal, Nachbarverzeichnis-Präfixe, native Windows-/gemischte
  Separatoren, kodierte Segmente und legitime verschachtelte Cache-Keys.
- Image-Grenzen: Ablehnung externer/rekursiver Quellen, lokale Quellen,
  selbst erzeugtes harmloses AVIF mit abweichender Endung/MIME, gültige
  JPEG-/WebP-Ausgaben, ungültige/leere Bilder und SVG-Verwechslung. Keine
  RCE-Payload. Die native Schwachstelle wird über verifizierte Library-Versionen
  abgesichert; der Test behauptet keine vollständige Exploit-Reproduktion.
- `npm ci`, `npm audit` (**0 gemeldete Vulnerabilities**), `npm run typecheck`,
  `npm run lint`, `npm run build` und der Live-Gate-Secret-Scan erfolgreich.
  Das Audit-Ergebnis allein genügt ausdrücklich nicht als Sicherheitsnachweis.
- `npm run security:live-gate`: **26 Next + 101 Auth + 78 Live-Gate** erfolgreich;
  Live-Gate-Zeilendeckung **95,68 %**, über dem bestehenden 95-%-Tor.
- Die vollständige Baseline-Suite hatte schon vor dem Fix **5 Fehler** in
  Doku-Pfadtests (`docsVersioning`, `portfolio.architecture`, `task10.architecture`)
  und **7 Skips**. Diese sachfremden Altfälle werden nicht durch Refactoring oder
  Test-Abschaltung kaschiert. Der Build meldet bekannte Tracing-Warnungen in
  unveränderten Dateisystemzugriffen (`auditSink.ts`, `docsCatalog.ts`).

## Akzeptanzkriterien

- [x] Aufgelöste Next-Version ≥16.3.3; dieses Release pinnt 16.3.4
- [x] Manifest erlaubt keine verwundbare Basisversion oder Prerelease-Range
- [x] Native Decoder-Kette inklusive geladener libheif-Version gepatcht
- [x] Regressionen vor dem Fix rot, nach dem Fix grün
- [x] Typecheck, Lint und Security-Live-Gate grün
- [x] Changelog mit betroffener Version und GHSA-/CVE-Referenzen
- [x] Fix-/Red-Test-Commits, Versionsangaben und betroffene READMEs aktualisiert

## Deployment und verbleibende Grenzen

[Upgrade-Runbook](../../../security/README.md#nextjs-upgrade-sec-03): alle Linux-/
Windows-Instanzen aus dem geprüften Lockfile frisch installieren, prüfen, neu
bauen und vollständig neu starten. Keine alten Build-/Image-/ISR-Caches oder
laufenden Prozesse übernehmen. Ein Manifest-Update allein schützt bestehende
Installationen nicht. Eigene libvips-/libheif-Builds müssen ebenfalls gepatcht sein.

Künftige Advisories weiter überwachen; der Versions-Floor ist kein allgemeiner
Beweis der Fehlerfreiheit. Verdacht auf frühere Kompromittierung verlangt eigene
Incident-Response. Andere Findings, insbesondere SEC-02 und SEC-04, bleiben offen.

## Versions-Hinweis

PATCH, Security-Dependency-Fix — v1.36.28, zeitnah auf allen Instanzen ausrollen.
