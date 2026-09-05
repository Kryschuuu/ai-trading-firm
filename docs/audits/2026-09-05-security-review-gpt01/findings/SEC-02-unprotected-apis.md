# SEC-02 — Ungeschützte APIs

- **ID:** SEC-02
- **Severity:** CRITICAL
- **Bereich:** API / Auth
- **Quelle:** Security Review-GPT_01.pdf, Kapitel Ungeschützte APIs
- **Status:** OPEN
- **Fix-Version:** -
- **Datei(en):** `src/app/api/*`, `src/lib/apiAuth.ts`, `src/lib/clientIp.ts`

## Beschreibung

Kritisches Finding: Einige API-Endpunkte sind ohne Auth-Guard erreichbar oder vertrauen client-kontrollierten Headern (z. B. `x-forwarded-for`) für Rate-Limiting/Identität. Ein Angreifer kann so Rate-Limits umgehen oder geschützte Aktionen ohne Token ausführen.

Bekannte Vektoren aus früheren Audits (C2, S-...):
- `x-forwarded-for` als Identität ohne `TRUSTED_PROXY_IPS`
- `GET` Endpunkte, die Seiteneffekte haben (bereits gefixt: `GET /api/firm/tick` → 405)
- Fehlende `guardWrite` in neuen Routen

## Beweis / PoC

```bash
# Ohne Token schreibenden Endpunkt aufrufen
curl -X POST http://localhost:3369/api/firm/run -H "Content-Type: application/json" -d '{}'
# Erwartet: 401/403
# Falls verwundbar: 200/409
```

```bash
# Rate-Limit-Bypass via X-Forwarded-For
for i in {1..10}; do
  curl -s -H "X-Forwarded-For: 1.2.3.$i" http://localhost:3369/api/brokers/[venue]/test
done
# Erwartet: nach 5 Versuchen 429
# Falls verwundbar: immer 200 (neuer Bucket pro IP)
```

## Remediation

1. **Alle Routen auditieren:** `grep -R "export async function" src/app/api/*/route.ts`
2. **Auth-Guard prüfen:** Jede schreibende Route muss `guardWrite` oder `requirePermission` aufrufen
3. **Client-IP:** `src/lib/clientIp.ts` ist einzige Quelle — `x-forwarded-for` nur hinter `TRUSTED_PROXY_IPS` + `x-verified-ip`
4. **CI-Gate:** `scripts/scan-secrets.ts` + `docs-validate` prüft, dass neue Routen Auth haben (Statik-Grep)

Referenz: C2-Fix in `docs/audits/2026-09-03-peer-review/findings/C2-forwarded-ip.md`.

## Akzeptanzkriterien

- [ ] Alle `POST/PUT/DELETE` Routen haben Auth-Guard
- [ ] `clientIp.test.ts` deckt Bypass ab
- [ ] `controlPlane.bruteforce.test.ts` grün
- [ ] Kein neuer Endpunkt ohne Guard (CI-Check)

## Changelog-Blurb

```
SEC-02 (CRITICAL): Ungeschützte APIs — Auth-Guards für alle schreibenden Endpunkte verifiziert
```
