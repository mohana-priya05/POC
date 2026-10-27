# UCP (Universal Commerce Protocol) on the E-commerce POC

This extends the existing app. There is no new frontend, no new app, and no change to existing tables.
It adds a UCP **business** side (a merchant server) on top of the existing catalogue, orders and Razorpay code.

- **Spec release:** UCP `2026-01-23` (git tag `v2026-01-23`, <https://ucp.dev/2026-01-23/>).
  The schemas in that release declare their own version as `2026-01-11` (the date of the last breaking change),
  so payloads carry `2026-01-11`. Both values live in [`src/ucp/config.ts`](../src/ucp/config.ts).
  The official schemas are vendored, unmodified, in [`ucp-schemas/`](../ucp-schemas) and the tests validate against them.
- **Transport:** REST only. **Capability:** `dev.ucp.shopping.checkout` only.
- **Not claimed:** full UCP conformance, a UCP payment handler, or connection to any AI platform. See [Limitations](#7-incomplete-requirements-and-known-limitations).

---

## 1. How it works

```
 Customer: "buy me a Canvas Backpack"
      │
      ▼
 AI client / "platform"  ── (A) GET  /.well-known/ucp ───────────► discovery profile
 (external, NOT in this repo)        what can this store do? where is the REST endpoint?
      │
      ├─ (B) product info ─ existing GET /api/products  (UCP 2026-01-23 has no catalog capability)
      │
      ├─ (C) POST /ucp/v1/checkout-sessions        create session   ─┐ server reads prices/stock
      ├─ (D) GET  /ucp/v1/checkout-sessions/{id}   inspect status    │ from MySQL and calculates
      ├─ (E) PUT  /ucp/v1/checkout-sessions/{id}   change qty/buyer  │ totals. Client prices are
      │                                                              ┘ ignored.
      ├─ (F) POST /ucp/v1/checkout-sessions/{id}/complete
      │         → creates ONE pending order, returns status=complete_in_progress + continue_url
      │
      ▼
 Buyer opens continue_url  →  existing React page /payment/{orderId}  →  Razorpay Checkout (TEST)
      │                       (card data goes to Razorpay, never to this server or the AI client)
      ▼
 existing POST /api/payments/verify   (and POST /api/payments/webhook)
      HMAC signature  +  fetch payment from Razorpay API  +  amount/order match
      → order PAID, stock decremented atomically
      │
      ▼
 GET /ucp/v1/checkout-sessions/{id}  →  status=completed, order={id, permalink_url}
```

| Layer | What it is | Where |
|---|---|---|
| Existing e-commerce | products, orders, Razorpay, React UI | `src/controllers`, `src/routes`, `frontend/` (unchanged except hardening below) |
| New UCP endpoints | discovery + checkout REST binding | `src/ucp/` |
| UCP protocol conformance | schema-valid responses, headers, idempotency, error shape | `src/ucp/`, verified by `tests/ucp.test.ts` |
| Razorpay processing | order creation, signature, status fetch, webhook | `src/controllers/paymentController.ts`, `src/services/orderService.ts` |
| External AI platform | the "platform" that calls `/ucp/v1` | **not included**; `scripts/ucpClient.ts` is a stand-in for demos |

**Why `complete` returns `complete_in_progress` and not `completed`:** UCP expects the platform to submit a payment
credential from a UCP *payment handler*. Razorpay is not one, and I did not invent one. The honest flow is: the server
validates and creates the order, then hands the buyer to the existing, trusted Razorpay Checkout page. The checkout
becomes `completed` only after the payment is verified server-side.

---

## 2. Files

**Added**

| File | Purpose |
|---|---|
| `src/ucp/config.ts` | spec version, capability names, spec URLs, env-driven settings |
| `src/ucp/profile.ts` | builds/serves `GET /.well-known/ucp` (advertises only what exists) |
| `src/ucp/routes.ts` | the 5 REST operations under `/ucp/v1`, middleware chain, rate limit |
| `src/ucp/middleware.ts` | raw-body parsing, header validation, API-key auth, `Request-Signature` check, idempotency store, error handler |
| `src/ucp/checkoutService.ts` | create/get/update/complete/cancel; validation; totals; status derivation; atomic transitions |
| `src/ucp/errors.ts` | UCP error/message shape |
| `src/ucp/platforms.ts` | registry of platforms allowed to call the API (API-key hash + public signing keys) |
| `src/services/orderService.ts` | `createPendingOrder` (shared) and `markOrderPaid` (the single place an order becomes PAID) |
| `prisma/migrations/20261026095545_ucp_checkout_sessions/` | two new tables (see §4) |
| `ucp-schemas/` | official UCP `source/` tree at tag `v2026-01-23` (Apache-2.0) |
| `scripts/ucp-setup.ts` | registers a local test platform (ES256 key pair + API key) |
| `scripts/ucpClient.ts`, `ucp-call.ts`, `ucp-demo.ts` | signing client, one-off signed call / curl generator, live demo (Tests A–M) |
| `tests/ucp.test.ts` | 54 integration tests (real MySQL, Razorpay mocked) |
| `docs/UCP.md` | this file |

**Modified**

| File | Change |
|---|---|
| `src/app.ts` | mounts `/.well-known/ucp` and `/ucp/v1` before the browser CORS policy; moved `morgan` above them |
| `src/controllers/orderController.ts` | `checkout` now calls the shared `createPendingOrder` (behaviour unchanged) |
| `src/controllers/paymentController.ts` | payment hardening (below) |
| `prisma/schema.prisma` | `CheckoutSession`, `IdempotencyRecord`, back-relation on `Order` (no column changes to existing tables) |
| `tests/payments.test.ts`, `tests/products.test.ts` | fixed an existing syntax error (`mPrisma.\`) and updated mocks for the new verify flow |
| `.env.example`, `package.json`, `/.gitignore` | env docs (it wrongly said PostgreSQL), npm scripts, ignore local keys |

**Payment hardening in the existing code** (needed for the payment requirements; found while inspecting):

1. The webhook accepted requests **with no signature**, so anyone could mark an order paid. It now requires a valid `X-Razorpay-Signature` over the raw body.
2. `verify` did not check that the Razorpay order belonged to *this* order. An attacker could pay a cheap order and replay that signature against an expensive one. It now checks the stored `razorpayOrderId`.
3. `verify` trusted the signature alone. It now also fetches the payment from Razorpay and requires `status=captured`, the right order id, amount and currency.
4. A forged signature used to flip the order to `FAILED` for anyone who knew the order id. It now changes nothing.
5. Stock was checked then decremented in two steps (race), and the webhook could decrement twice. Both paths now use `markOrderPaid`: a conditional `PENDING→PAID` update (one winner) plus a guarded `UPDATE … WHERE stock >= qty`.

---

## 3. Implemented endpoints

| Method + path | Operation | Success |
|---|---|---|
| `GET /.well-known/ucp` | discovery profile | 200 |
| `POST /ucp/v1/checkout-sessions` | create | 201 |
| `GET /ucp/v1/checkout-sessions/{id}` | get | 200 |
| `PUT /ucp/v1/checkout-sessions/{id}` | update (full replacement) | 200 |
| `POST /ucp/v1/checkout-sessions/{id}/complete` | complete | 200 |
| `POST /ucp/v1/checkout-sessions/{id}/cancel` | cancel | 200 |

Required request headers on `/ucp/v1`: `UCP-Agent: profile="<uri>"`, `Request-Id` (UUID), `X-API-Key`,
`Request-Signature`, and `Idempotency-Key` (UUID) on every POST/PUT. Errors: 400 / 401 / 403 / 404 / 409 / 413 / 429 / 500
with `{ ucp, messages:[{type, code, content, severity, path?}] }`.

Status model (stored + derived from the order): `incomplete` → `ready_for_complete` → `complete_in_progress` → `completed`,
and `canceled` (explicit cancel, expiry after 6 h, or the order being cancelled). `requires_escalation` is not used.

Business rules: prices, titles, currency (`INR`, minor unit = paise) and totals always come from MySQL. Quantity is 1–100 per
product, ≤ 50 lines. A buyer needs `email`, `phone_number` (E.164) and a first or last name before the session is
`ready_for_complete`. Stock is re-checked at update and at complete (not reserved; see limitations).

---

## 4. Database migration

Reviewed before applying; it is additive only (2 × `CREATE TABLE`, 1 FK on the new table). No existing table or row is touched.

```
backend/prisma/migrations/20261026095545_ucp_checkout_sessions/migration.sql
```
- `CheckoutSession(id, status, currency, lineItems JSON, buyer JSON, platformProfile, orderId UNIQUE → Order.id, expiresAt, …)`
- `IdempotencyRecord(scope, idemKey, requestHash, state, responseStatus, responseBody JSON, createdAt)`, `UNIQUE(scope, idemKey)`

Apply on another machine: `npx prisma migrate deploy && npx prisma generate` (stop the backend first on Windows, it locks the engine DLL).

---

## 5. Environment variables (no secrets in the repo)

See [`.env.example`](../.env.example). New/important ones:

| Variable | Purpose |
|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay **test** keys (secret stays on the server, never sent to the browser) |
| `RAZORPAY_WEBHOOK_SECRET` | now **required** for the webhook (503 if empty) |
| `UCP_PUBLIC_BASE_URL` | public https URL advertised in discovery (default `http://localhost:PORT`) |
| `UCP_PLATFORMS_FILE` | platform registry (default `./ucp-platforms.json`, created by `npm run ucp:setup`, git-ignored) |
| `UCP_RATE_LIMIT_PER_MIN` | per-IP limit on `/ucp/v1` (default 120) |
| `UCP_TERMS_URL`, `UCP_PRIVACY_URL` | legal links returned in every checkout (the frontend has no such pages yet) |

---

## 6. Run and test

```powershell
cd E:\POC\ecommerce-poc\backend
npm install
npx prisma migrate deploy
npx prisma generate
npm run ucp:setup          # once: registers the local test platform (keys stay on this machine)
npm run dev                # backend  http://localhost:5000
# second terminal
cd E:\POC\ecommerce-poc\frontend; npm run dev     # http://localhost:5173
```

```powershell
npm test                   # all backend tests (61): existing + UCP, real DB, Razorpay mocked
npm run test:ucp           # just the 54 UCP tests
npm run ucp:demo           # live walkthrough, Tests A-G, J(server side), K, L, M against the running server
npm run ucp:demo -- --pay  # + Tests H/I: creates a real PENDING order, prints the pay link, waits for your Razorpay test payment
```

**Manual signed requests.** The signature changes with the body, so curl alone is not enough. `ucp:call` signs and sends:

```powershell
npm run ucp:call -- GET /checkout-sessions/chk_xxx
# put the JSON in a file to avoid shell quoting problems (body.json:
#   {"line_items":[{"item":{"id":"<product-id>"},"quantity":2}]} )
npm run ucp:call -- POST /checkout-sessions @body.json
npm run ucp:call -- POST /checkout-sessions @body.json --curl   # prints an equivalent curl with a fresh signature
```
(In Git Bash set `MSYS_NO_PATHCONV=1`, otherwise `/checkout-sessions` is rewritten into a Windows path.)

A Postman collection is **not** provided: `Request-Signature` is an ES256 detached JWS over the body, which Postman's
sandbox cannot produce reliably. `ucp:call --curl` covers the manual case.

### Expected results (real output from this repo)

**A. Discovery** `GET /.well-known/ucp` → 200
```json
{ "ucp": { "version": "2026-01-11",
  "services": { "dev.ucp.shopping": [ { "version": "2026-01-11", "transport": "rest",
      "spec": "https://ucp.dev/2026-01-23/specification/overview",
      "endpoint": "http://localhost:5000/ucp/v1",
      "schema": "https://ucp.dev/services/shopping/rest.openapi.json" } ] },
  "capabilities": { "dev.ucp.shopping.checkout": [ { "version": "2026-01-11",
      "spec": "https://ucp.dev/2026-01-23/specification/checkout",
      "schema": "https://ucp.dev/schemas/shopping/checkout.json" } ] },
  "payment_handlers": {} } }
```

**B. Products** `GET /api/products?limit=20` → 200 `{ success, data:[{ id, name, pricePaise, stock, … }], pagination }`

**C/G. Create (client lies about the price)** `POST /ucp/v1/checkout-sessions`
```json
{ "line_items": [ { "item": { "id": "<id>", "title": "Free!", "price": 1 }, "quantity": 2 } ] }
```
→ **201**, `status: "incomplete"`, `line_items[0].item.price: 299900` (database price, not 1),
`totals: [{subtotal 599800},{total 599800}]`, and `messages` listing `missing` for `$.buyer.email`, `$.buyer.phone_number`, `$.buyer.first_name`.

**D. Get** → 200, same body as create.

**E. Update** `PUT …/{id}` with `buyer` and `quantity: 3` → 200, `status: "ready_for_complete"`, total recalculated (`3 × price`).

**F. Invalid input**
- unknown product → **400** `messages:[{code:"invalid", path:"$.line_items[0].item.id", severity:"recoverable"}]`
- quantity `0`, `-5`, `1.5`, `"2"`, `>100` → **400**
- quantity above stock → session created with `out_of_stock` message at `$.line_items[0].quantity`; `complete` → **409**, no order

**H. Complete** `POST …/{id}/complete` `{}` → 200
```json
{ "status": "complete_in_progress",
  "continue_url": "http://localhost:5173/payment/<orderId>",
  "order": { "id": "<orderId>", "permalink_url": "http://localhost:5173/order/<orderId>" },
  "messages": [ { "type": "info", "code": "payment_pending", "content": "Order created. The buyer must finish payment on continue_url (Razorpay Checkout)." } ] }
```
Calling complete again (new key or same) returns the same order. It never creates a second one.

**I. After a successful Razorpay payment** `GET …/{id}` → `status: "completed"`, no `continue_url`, `order` present;
MySQL `Order.status = PAID`, `Payment.status = PAID` with `razorpayOrderId` / `razorpayPaymentId`, stock decremented once.

**J. Payment failure** (all covered by automated tests): forged signature → 400 and nothing changes; valid signature for another
order's Razorpay order → 400; wrong amount → 400; Razorpay `failed` → 400 and `Payment=FAILED` (order stays `PENDING`, retry works);
`authorized` but not captured → 409; Razorpay unreachable → 502. In every case the order is **not** marked paid.

**K. Cancel** → 200 `status: "canceled"`; update/complete afterwards → 409; cancel again → 200 (safe). After a payment attempt
has started (Razorpay order exists) cancel → **409** `cancel_not_allowed`, because money may be in flight.

**L. Idempotency** same `Idempotency-Key` + same body → identical response + `Idempotent-Replayed: true`, one session; same key
+ different body → **409** `idempotency_key_reuse`. Keys are scoped per platform + method + path and kept 48 h.

**M. Security**

| Case | Result |
|---|---|
| no / non-UUID `Request-Id` | 400 |
| no / malformed `UCP-Agent` | 400 |
| no / non-UUID `Idempotency-Key` on POST/PUT | 400 |
| platform not in registry | 403 |
| no / wrong `X-API-Key` | 401 |
| no `Request-Signature` | 401 `signature_required` |
| signature over a different body, corrupted, or from an unregistered key | 401 `invalid_signature` |
| more than the limit per minute | 429 |
| another platform's session id | 404 |

### Automated test results (actual runs)

| Suite | Result |
|---|---|
| `npm test` (existing + UCP) | **3 suites, 61 tests, 61 passed** |
| `tests/ucp.test.ts` | 54 passed. Includes responses validated against the **official** `checkout.json` schema and the discovery profile validated against the official profile schema |
| `npm run ucp:demo` against the live server | **all checks passed** (Tests A–G, J server-side, K, L, M) |
| Live Razorpay payment (Tests H/I end-to-end in a browser) | **not run by me**: it needs a person to pay in Razorpay Checkout. Run `npm run ucp:demo -- --pay` |

**Test N, official conformance suite** (<https://github.com/Universal-Commerce-Protocol/conformance>, `main`, run via pytest):

> **1 passed, 61 failed, 15 skipped.** The one pass is `protocol_test::test_discovery`.

This number must not be read as "61 requirements are broken". It mostly measures a mismatch of setups:

1. The suite calls with its own mock agent profile, **no API key** and the literal signature `request-signature: test`. This
   server correctly answers `403 unknown_platform` / `401`. The suite assumes an open server; I did not add an "auth off"
   switch to get a green run.
2. The suite targets a newer release (`2026-04-08`, SDK 0.4.6; the repo has no tag for `2026-01-23`) and
   expects `completed` straight from `complete`.
3. Many tests need capabilities that are not implemented (fulfillment, discount, order, buyer consent). Those are not advertised.

To get a meaningful conformance score you would need a test mode that registers the suite's mock agent and accepts its
placeholder signature, plus the missing capabilities. That is future work.

---

## 7. Incomplete requirements and known limitations

**Spec / protocol**
- **Not conformant.** Only checkout over REST is implemented. No fulfillment, discount, order (webhooks), buyer-consent, AP2, MCP, A2A or embedded transport.
- **No UCP payment handler.** `payment_handlers` is `{}`. `complete` does not take a payment instrument (it is validated as an object and
  never read or stored). The spec says `payment` is required on complete. This is a deliberate, documented deviation.
  Also `complete` returns `complete_in_progress`, not `completed`.
- **`Request-Signature` format is my interpretation.** The 2026-01-23 REST page marks the header required but only specifies a format for
  webhooks (detached JWT, RFC 7797). I applied that format to requests (ES256, `b64:false`, `kid`). It covers the body only, so it does not
  bind method/path/time (replay is limited by HTTPS and idempotency). Platform keys are **pre-registered**, not fetched from the
  `UCP-Agent` profile URL, which would be an SSRF risk without extra controls.
- **Authentication:** API key + signature (open access is also allowed by the spec; I chose to require both). OAuth bearer and mTLS are not implemented.
- **HTTPS / TLS 1.3 is required by the spec;** local runs are plain HTTP. `continue_url` should be absolute HTTPS. Set `UCP_PUBLIC_BASE_URL`
  and `FRONTEND_URL` to https URLs (e.g. a tunnel) for a real handoff.
- `continue_url` is only returned once an order exists (the app has no web page to resume an unfinished checkout). The spec says SHOULD for other non-terminal states.
- No `version_unsupported` negotiation (the 2026-01-23 REST binding has no version header). No `requires_escalation` state. No `Accept-Language` handling.
- `links` point at `/terms` and `/privacy` on the frontend, which do not exist yet.
- The Postman collection is not provided (see §6).

**Commerce / payments**
- **Stock is not reserved** between `complete` and payment. It is re-checked and decremented atomically at payment time. If two buyers race for the last unit,
  the second payment is refused by the server *after* Razorpay may have captured it. That needs a manual refund (Razorpay refund API not wired).
- If an order is cancelled/expired while a Razorpay payment is already captured, `verify` refuses it and the money needs a manual refund. Cancel is blocked once payment has started to make this unlikely, not impossible.
- `complete_in_progress` sessions never expire on their own (only the pending order exists). There is no job to cancel stale pending orders.
- **Delivery address:** UCP fulfillment is not implemented, so UCP orders store the placeholder `Not provided via UCP (fulfillment capability not implemented)`. A real shop must collect an address.
- No tax, shipping or discounts: `total = subtotal`.
- The webhook only handles `payment.captured`, `order.paid` and `payment.failed`; `payment.failed` marks the *payment* failed but leaves the order `PENDING` so the buyer can retry.
- A webhook with a business-rule failure is acknowledged (200) and logged, not retried.
- Rate limiting is in-memory and per IP (single instance). Idempotency records are in MySQL (multi-instance safe).
- The existing `create-order` endpoint is unauthenticated and creates a new Razorpay order on every call (pre-existing; unchanged).

**Environment**
- The conformance suite was run from a clone in a scratch folder with its own Python venv; nothing from it is in this repo.

---

## 8. External AI platform integration (what is *not* included)

A working `/.well-known/ucp` and `/ucp/v1` on localhost does **not** connect this shop to ChatGPT, Gemini, Copilot or any other assistant. To get there you would need, at least:

1. A **public HTTPS URL** (real domain or tunnel) so the profile advertises reachable endpoints, with `UCP_PUBLIC_BASE_URL` set to it.
2. **Onboarding with each platform**: they decide which merchants they trust. Expect to register your business, exchange credentials (API key / OAuth client)
   and give them your public signing keys. Each platform has its own programme and requirements.
3. A real **UCP payment handler** that the platform can use to obtain a payment credential (for example one provided by a payment provider or wallet),
   plus the required prerequisites. Razorpay would need a published handler spec or a PSP-provided one. Until then, payment stays on the web hand-off.
4. The remaining capabilities platforms expect for a smooth purchase (fulfillment/address, order webhooks, usually discounts), and passing the official conformance suite.
5. Legal and operational pieces: terms/privacy pages, refund handling, support, production hosting, monitoring.

---

## 9. Demonstrating the POC to your manager (≈ 10 minutes)

1. **Say what it is.** "Any AI shopping assistant that speaks UCP can discover our store, build a cart with us and send the buyer to pay. Today we prove the store side locally. A real assistant would be the same calls from a different caller."
2. **Start** backend + frontend (§6). Open the shop at <http://localhost:5173>.
3. **Discovery.** Open <http://localhost:5000/.well-known/ucp> in the browser. Point out: one capability (checkout), REST endpoint, **no payment handler** (we are honest about what we support).
4. **Run `npm run ucp:demo`** and walk through the output:
   create → server ignores the fake ₹0.01 price → update quantity and total changes → bad product / bad quantity rejected → repeat request is safe → missing/forged signature and API key rejected → cancel.
5. **Run `npm run ucp:demo -- --pay`.** When it prints the link, open it, pay with Razorpay test card `4111 1111 1111 1111` (any future expiry, any CVV, any OTP). The script then shows the checkout flip to `completed` and the order `PAID` in MySQL.
6. **Show the safety work:** `npm test` (61 green), and mention the existing webhook hole that is now closed (§2).
7. **Be upfront about limits** (§7–8): not fully conformant, no UCP payment handler yet, needs HTTPS, platform onboarding and fulfillment before a real assistant could sell through it.
