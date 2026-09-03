# H4 — Keine echte Order-Idempotenz; Retry auf POST/429 kann Doppelorders erzeugen

- **Severity:** CRITICAL
- **Bereich:** Handelslogik / Broker
- **Status (validiert):** ✅ **Gefixt** in **v1.36.5** (siehe `CHANGELOG.md` `[1.36.5]`).
- **Datei(en):** `src/brokers/bitunix/http.ts` (L207 `if (res.status === 429 || idempotent) continue;`),
  `src/brokers/bitunix/privateClient.ts` (`placeSerializedOrder`), `src/brokers/bitunix/types.ts` (`BitunixPlaceOrderBody`)

## Arena-Prompt (kopierbar)

```
TASK: Add real client-order idempotency to Bitunix live orders; never blindly retry a
non-idempotent POST.

PROBLEM: http.ts retries a non-idempotent place_order on HTTP 429 (and the code comment
assumes 429 == "definitely not processed"). A financial client must never rely on HTTP
semantics to dedupe an order. Also no clientOrderId is generated/sent.

DO:
1. Add a stable clientOrderId to the order:
   - In BitunixPlaceOrderBody (src/brokers/bitunix/types.ts): `clientOrderId?: string;`
   - In serializePlaceOrder (src/brokers/bitunix/orders.ts): generate
       const clientOrderId = `ATF-${accountId}-${intentId}`;  // pass accountId+intentId in
     and set body.clientOrderId.
   - hash/shorten if the venue limits length; keep it collision-resistant per account+intent.
2. In BitunixPrivateClient.placeSerializedOrder, accept/derive clientOrderId and return it:
     async placeSerializedOrder(body, opts?: { clientOrderId?: string })
3. Add a query-by-clientOrderId path:
     getOrderByClientId(clientOrderId): Promise<{ orderId, status } | null>
   (GET /api/v1/futures/trade/order?clientOrderId=... or the venue's equivalent).
4. Change the retry contract in http.ts: for NON-idempotent requests, do NOT auto-retry on 429.
   Instead surface a typed `BitunixAmbiguousError` (kind: "ambiguous"). The caller
   (privateClient) catches it and, BEFORE any resend, calls getOrderByClientId:
     - found  -> return the existing order (no resend)
     - not found -> perform ONE controlled retry with the SAME clientOrderId
5. Add tests: (a) 429 then query returns existing order -> no duplicate; (b) 429 then query
   empty -> exactly one retry with identical clientOrderId.

ACCEPTANCE: No code path resends a place_order without first querying by clientOrderId; the
clientOrderId is stable across retries; tests prove no duplicate order is created.
```

## Beweis (aktueller Code)

`src/brokers/bitunix/http.ts` L198‑207:

```ts
if (res.status === 429 || res.status >= 500) {
  ...
  // 429 = definitiv nicht verarbeitet → immer Retry-fähig.
  if (res.status === 429 || idempotent) continue;   // <-- non-idempotent POST resent on 429
  throw last;
}
```

`src/brokers/bitunix/privateClient.ts` `placeSerializedOrder(body)` — kein `clientOrderId`.

## Fix-Spezifikation

`clientOrderId` generieren + mitsenden; Retry nur nach Status-Query durch `clientOrderId`
(siehe Audit H4-Skizze: POST → bei Timeout erst GET by clientOrderId).

## Akzeptanzkriterien / Tests

- [x] `clientOrderId` wird erzeugt, gesendet und bei Retry wiederverwendet.
- [x] Bei 429/Timeout: erst `getOrderByClientId`, dann ggf. genau ein Retry.
- [x] Test belegt: kein Doppel-Order bei 429 + bereits existierender Order.

## Changelog-Blurb

`H4 (CRITICAL): Fehlende Order-Idempotenz — clientOrderId (ATF-account-intent) + Retry nur nach
Status-Query; nie blindes Wiederholen nicht-idempotenter POSTs bei 429/Timeout.`

## Versions-Hinweis

PATCH (`1.36.3`) — Verhaltens-Härtung, keine Breaking API-Änderung nach außen.
