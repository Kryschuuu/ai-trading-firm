# C1 — Ohne gesetztes Token läuft die komplette Write-API offen

- **Severity:** HIGH
- **Bereich:** Control Panel
- **Status (validiert):** ✅ **Valide.**
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

## Beweis (aktueller Code)

`src/lib/apiAuth.ts` L38‑42:

```ts
export function checkApiToken(req: Request): Response | null {
  const expected = process.env.FIRM_API_TOKEN;
  if (!expected) return null; // Off-Betrieb   <-- offener Admin ohne Konfiguration
  ...
}
```

`src/auth/resolve.ts` L107‑110: `if (!adminTok && !operatorTok && !viewerTok) return { ok: true, actor: buildActor("admin", "local-open", env) };`

## Fix-Spezifikation

Production-Refusal + expliziter `AUTH_MODE=local-open` (Opt-in); kein impliziter Open-Mode in Prod
(siehe Audit C1).

## Akzeptanzkriterien / Tests

- [ ] `NODE_ENV=production` ohne Token → Boot-Fehler (kein Start).
- [ ] `AUTH_MODE=local-open` muss explizit gesetzt sein, damit Dev offen läuft.
- [ ] Mit Token: Write-Endpunkte verlangen `x-firm-token`.

## Changelog-Blurb

`C1 (HIGH): Write-API ohne Token offen — Production-Refusal + opt-in AUTH_MODE=local-open; kein
impliziter Admin-Open-Mode in Produktion.`

## Versions-Hinweis

PATCH (`1.36.3`) — Sicherheits-Härtung (neues Env `AUTH_MODE`, Boot-Check).
