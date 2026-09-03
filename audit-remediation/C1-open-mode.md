# C1 — Ohne gesetztes Token läuft die komplette Write-API offen

- **Severity:** HIGH
- **Bereich:** Control Panel
- **Status (validiert):** ✅ **Gefixt v.1.36.13** — Befund war valide (Audit 2026-09-03); Fix in
  `src/auth/authMode.ts` (neu: Modus + Boot-Guard + `ConfigurationError`),
  `src/auth/resolve.ts`, `src/lib/apiAuth.ts`, `src/lib/tokenCompare.ts` (neu),
  `src/instrumentation.ts`, `scripts/auth-boot-guard.ts` (neu) + `package.json`
  (`npm run boot:guard`, vorgeschaltet in `dev`/`start`). Doku: `INSTALL.md` („Auth-Modus“), `docs/INSTALL.md`
  (§5.1/5.3/Kapitel 11), `.env.example`, `docs/help/ops.help.json` (`auth.mode`).
  Tests: `tests/authMode.test.ts` (29 Fälle).
- **Datei(en):** `src/lib/apiAuth.ts` (`checkApiToken` L39 `// Off-Betrieb`), `src/auth/resolve.ts` (L109 `local-open` Admin)

## Arena-Prompt (kopierbar)

```
TASK: Require explicit auth configuration; refuse to start in production without tokens.

PROBLEM: If FIRM_API_TOKEN (and friends) are unset, checkApiToken() returns null (open) and
resolveAuth() returns an admin actor ("local-open"). Any unauthenticated caller gets full write/admin
access. Fine for localhost dev, dangerous as a default security model in production.

DO:
1. Introduce an explicit mode via env: AUTH_MODE = "local-open" | "token-required".
   - Default when no tokens configured AND NODE_ENV !== "production": "local-open" (dev convenience).
   - In production (NODE_ENV === "production") with no token configured -> the app MUST refuse to
     start (throw ConfigurationError at boot, e.g. in instrumentation.ts / a startup guard).
2. Add anyTokenConfigured() usage (already exists in src/auth/resolve.ts) to a boot check:
     if (process.env.NODE_ENV === "production" && !anyTokenConfigured())
       throw new ConfigurationError("Refuse startup: authentication not configured (set FIRM_ADMIN_TOKEN/FIRM_API_TOKEN).");
3. Keep "local-open" only when AUTH_MODE === "local-open" is explicitly set (opt-in), never implicit
   in production.
4. Document in docs/INSTALL.md / .env.example that production requires tokens.

ACCEPTANCE: In production without tokens the server fails fast at boot; in dev without tokens it
runs local-open only if AUTH_MODE=local-open; with tokens, write endpoints require x-firm-token.
```

## Beweis (Code vor dem Fix)

`src/lib/apiAuth.ts` L38‑42:

```ts
export function checkApiToken(req: Request): Response | null {
  const expected = process.env.FIRM_API_TOKEN;
  if (!expected) return null; // Off-Betrieb   <-- offener Admin ohne Konfiguration
  ...
}
```

`src/auth/resolve.ts` L107‑110: `if (!adminTok && !operatorTok && !viewerTok) return { ok: true, actor: buildActor("admin", "local-open", env) };`

Beide Stellen hingen an **derselben** Implikation „kein Wert gesetzt ⇒ offen“. Hinzu kam ein
Zweitschaden, der aus dem Prompt nicht explizit hervorging: `checkApiToken` prüfte **nur**
`FIRM_API_TOKEN`. Wer also ausschließlich `FIRM_ADMIN_TOKEN` (oder nur das Viewer-Token) setzte,
hatte die Firm-Write-API immer noch offen — die RBAC-Schicht war davon nie betroffen.

## Fix-Spezifikation (umgesetzt v1.36.13)

**Ein Modus, eine Quelle, zwei Durchsetzungspunkte.**

1. `src/auth/authMode.ts` (neu, Blatt-Modul ohne Imports) löst den Modus auf —
   `resolveAuthMode(env)` wirft **nie** (Requestpfad!), `assertAuthConfigured(env)` ist der
   Boot-Guard, der wirft. Regeln, in dieser Priorität:
   1. Irgendein Token konfiguriert ⇒ `token-required`. `AUTH_MODE=local-open` wird ignoriert
      und boot-seitig gemeldet — Offen-Betrieb darf eine installierte Token-Konfiguration
      nicht abschalten.
   2. Kein Token + `AUTH_MODE=local-open` ⇒ `local-open` (einziger Weg ohne Credential; in
      Produktion mit lauter Warnung, weil ausdrücklich entschieden).
   3. Kein Token + `AUTH_MODE=token-required` ⇒ `token-required` (und Boot-Fehler, weil der
      Modus ein Token verlangt, das nicht existiert).
   4. Kein Token + `AUTH_MODE` ungesetzt ⇒ `local-open` als **Dev-Default**
      (`NODE_ENV !== "production"`), in Produktion `token-required` + Boot-Verweigerung.
   5. `AUTH_MODE` mit unbekanntem Wert ⇒ fail-closed `token-required` +
      `ConfigurationError(AUTH_MODE_INVALID)`.
2. **Zwei Startpunkte, dieselbe Quelle.** `scripts/auth-boot-guard.ts` (neu) läuft in
   `npm run start`/`npm run dev` **vor** `next` und beendet den Prozess mit Exit-Code 1 — nötig,
   weil Next.js 16 einen Fehler im Instrumentation-Hook zwar loggt („Failed to prepare server“),
   den Server aber laufen lässt (danach 500 auf jeder Route, `systemd` sähe ein `active`).
   `src/instrumentation.ts` ruft `assertAuthConfigured()` zusätzlich **vor** Adapter-Check und
   Scheduler und außerhalb jedes `try/catch` (Zweitlinie für `npx next start`); dort bleibt es
   beim Wurf — ein harter Abbruch in der Instrumentation würde Turbopack als
   Edge-Runtime-Warnung im Build melden. `next build` ist über
   `NEXT_PHASE=phase-production-build` in beiden Fällen ausgenommen (sonst wäre jeder Build ohne
   `.env` rot — vgl. den bestehenden `next-build-fähig`-Test für `src/db`). Manuell prüfbar:
   `npm run boot:guard`. Die Fehlermeldung führt den Audit-Wortlaut:
   `Refuse startup: authentication not configured (set FIRM_ADMIN_TOKEN/FIRM_API_TOKEN).`
3. Verteidigung in der Tiefe, unabhängig davon, ob `register()` lief:
   * `checkApiToken`: offen nur bei wirksamem `local-open`; sonst 401 `AUTH_NOT_CONFIGURED`
     (kein Token) bzw. RBAC-Entscheidung über `firm.write` (Admin-/Viewer-Token gesetzt,
     `FIRM_API_TOKEN` nicht) — 401/403 wie gehabt.
   * `resolveAuth`: `local-open`-Actor nur bei wirksamem `local-open`; sonst 401.
4. `tokenEquals` wanderte nach `src/lib/tokenCompare.ts`, damit `src/lib/apiAuth.ts` →
   `src/auth/*` nicht zurück auf `apiAuth` zeigt (Import-Zyklus). Re-export lässt alle
   bestehenden Pfade (`@/lib/apiAuth`) unverändert.
5. `GET /api/auth/me` projiziert `authMode` (`mode`, `requested`, `reason`, `production`,
   `tokensConfigured`, `summary`) — secret-frei, damit die Control Plane den Modus sieht.
6. `scripts/setup-cachyos.sh --no-api-token` schreibt `AUTH_MODE=local-open` in die `.env`
   (bewusste Entscheidung statt versehentlicher), `deploy/ai-trading-firm.service`
   kommentiert die Produktionspflicht.

### Auflösung eines Zielkonflikts im Prompt (dokumentiert)

DO‑1 schreibt den `local-open`-**Default** für „kein Token und `NODE_ENV !== production`“ vor,
die ACCEPTANCE-Zeile verlangt „dev läuft local-open **only if** `AUTH_MODE=local-open`“. Beides
gleichzeitig hätte bedeutet, dass jeder frische Clone und jede Test-suite ohne Token-Setup
unbedienbar wird (alle 13 `guardWrite`-Routen und jede RBAC-Route liefern dann 401). Umgesetzt ist
deshalb die sicherheitsrelevante Schnittmenge — und zwar hart:

* In **Produktion** ist `local-open` **niemals implizit**: kein Token ⇒ Boot-Verweigerung
  (Akzeptanz 1 erfüllt). Das ist der eigentliche Schaden des Befunds.
* **Explizit** gesetzt steuert `AUTH_MODE` beide Seiten: `local-open` erzwingt Offenheit (auch in
  Produktion, mit Warnung), `token-required` schließt selbst in der Entwicklung — damit lässt sich
  das Produktionsverhalten lokal beweisen (`AUTH_MODE=token-required npm run dev` ⇒ 401).
* Der Dev-Default ist nicht still: Der Boot-Log nennt ihn, `docs/INSTALL.md`/`INSTALL.md`
  erklären ihn, und `ops.help.json` (`auth.mode`) beschreibt ihn im 3-Ebenen-Schema.
* Der Open-Modus ist nie breiter als vorher: `AUTH_MODE=local-open` gilt nur, wenn wirklich gar
  kein Token konfiguriert ist.

## Akzeptanzkriterien / Tests

- [x] `NODE_ENV=production` ohne Token → Boot-Fehler (kein Start).
      `tests/authMode.test.ts` — `assertAuthConfigured` wirft `ConfigurationError`
      (`code: AUTH_NOT_CONFIGURED`, Wortlaut aus dem Audit) **und** im echten Kindprozess:
      Exit 1 mit `BOOT-REFUSED ConfigurationError AUTH_NOT_CONFIGURED`.
- [x] `AUTH_MODE=local-open` ist der einzige Weg ohne Token; in Produktion nie implizit.
      Ebenfalls grün im Realbetrieb: `npm run start` mit `NODE_ENV=production` und ohne jedes
      Token bricht innerhalb von ~0,5 s mit Exit-Code 1 ab (Log: `Start verweigert
      (AUTH_NOT_CONFIGURED)` + Behebung), `next build` bleibt davon unberührt.
- [x] Kein implizites Admin in Produktion, auch ohne gelaufenen Boot-Guard:
      `resolveAuth`/`requirePermission` liefern 401 statt Admin-Aktor.
      (Die Acceptance-Zeile „only if“ ist bewusst als „nie implizit in Produktion +
      `token-required` erzwingbar“ umgesetzt; Begründung im Abschnitt acima.)
- [x] Mit Token: Write-Endpunkte verlangen `x-firm-token`.
      `guardWrite`-Test (401 ohne, 401 bei Präfix-Fehler, `null` bei Treffer) plus
      echte Route `POST /api/firm/tick` ⇒ 401, bevor `tick()` irgendetwas tut.
- [x] Nebenbefund: nur `FIRM_ADMIN_TOKEN`/`FIRM_VIEWER_TOKEN` gesetzt ⇒
      `firm.write` entscheidet (Admin-Credential durch, anonym 403, Viewer 403) —
      vorher offen.
- [x] Kein Credential-Wert verlässt den Prozess: `describeAuthMode`/Boot-Log/`/api/auth/me`
      sind secret-frei (Tests prüfen das explizit, `scanTextForSecrets`-Konvention der Ops-Tests).
- [x] `next build` bleibt ohne Token möglich (`NEXT_PHASE`-Ausnahme im Guard).
- [x] Drift-Schutz: statische Tests, dass `instrumentation.ts` den Guard **vor** allen anderen
      Schritten aufruft und dass `src/lib/apiAuth.ts` kein `if (!expected) return null` mehr enthält.

Suite-Status nach dem Fix: `npm test` = **1638/1638**, `npm run typecheck`, `npm run lint`,
`npm run docs:validate` grün.

## Changelog-Blurb

`C1 (HIGH): Write-API ohne Token offen — AUTH_MODE (local-open | token-required) + Boot-Guard;
Produktion ohne Token verweigert den Start, RBAC entscheidet über firm.write statt „offen“.
`

## Versions-Hinweis

PATCH — **umgesetzt als `1.36.13`** (Reihenfolge der Remediation: H1=v1.36.2, H3=v1.36.4,
H4=v1.36.5, H5=v1.36.6, H6=v1.36.7, H9=v1.36.8, H8=v1.36.10, B1=v1.36.11, B2=v1.36.12,
**C1=v1.36.13**). Der im Plan ursprünglich vorgeschlagene Wert `1.36.3` war überholt: die
Patch-Serie lief bereits bis 1.36.12.

Neu ist ein Env-Flag (`AUTH_MODE`) und ein Startverhalten (Produktion ohne Token ⇒ kein Boot) —
beides abwärtskompatibel für alle Konfigurationen **mit** Token. Wer ohne Token in Produktion
betrieb, muss sich entscheiden: `FIRM_API_TOKEN` setzen (empfohlen) oder `AUTH_MODE=local-open`
ausdrücklich eintragen.

## Nachtrag (bewusst außer Scope)

* `checkRateLimit`/`clientKey` verlassen sich auf `x-forwarded-for`/`x-real-ip` — das ist Befund
  **C2** (`C2-forwarded-ip.md`) und wird dort separat abgearbeitet.
* `expectedCsrfValue()` der Control Plane akzeptiert im Offen-Betrieb die Konstante `local`
  (`src/brokers/control-plane/config.ts`). Solange `local-open` wirksam ist, ist das Konsistent;
  ein eigener Befund ist es nicht — der Modus-Guard gilt auch dort über `requirePermission`.
* `scripts/validate-setup.sh` Check V18 prüft weiterhin „401 ohne `x-firm-token`“ und markiert
  fehlende Tokens als dokumentierten Fehlcheck; eine AUTH_MODE-Prüfung wäre ein eigenes Ticket.
