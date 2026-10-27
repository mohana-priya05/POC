# E-commerce POC with UCP: Full Project Report

Written for: you (the developer of this POC), and anyone you share it with, such as your manager.
Covers the application, everything that was done in this working session, how UCP was added, and what is still open.

Date of the work: 26 October 2026. Report written: 27 October 2026.

---

## Contents

1. [Summary](#1-summary)
2. [The application](#2-the-application)
3. [What was done, in order](#3-what-was-done-in-order)
4. [How UCP was created](#4-how-ucp-was-created)
5. [File inventory](#5-file-inventory)
6. [How to run and test](#6-how-to-run-and-test)
7. [Test results](#7-test-results)
8. [Security notes](#8-security-notes)
9. [Open items and limitations](#9-open-items-and-limitations)
10. [The pending order-visibility proposal](#10-the-pending-order-visibility-proposal)
11. [Where to find more](#11-where-to-find-more)

---

## 1. Summary

You had a working e-commerce POC (React + Node/Express + MySQL + Razorpay test mode). In this session:

1. **Fixed the Add to Cart button.** The cart was not shared between components.
2. **Explained the Razorpay "Failed to create Razorpay order" error.** It was caused by placeholder API keys. Not a code bug.
3. **Added UCP (Universal Commerce Protocol) support** on top of the existing app: a discovery profile and a checkout REST API, reusing your products, orders and Razorpay flow.
4. **Hardened the existing payment code.** It had real security holes that the UCP payment requirements exposed.
5. **Wrote tests and a live demo.** 61 backend tests pass. The live demo script passes.
6. **Investigated why a UCP-created order was not visible on the website.** Root cause found. A proposed fix is waiting for your approval. **Nothing was changed for this yet.**

What is **not** true: the app is not fully UCP-conformant, it is not connected to ChatGPT or any other AI platform, and I have not run a real Razorpay payment through the UCP flow in a browser.

---

## 2. The application

### 2.1 Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, React Router 6, Axios |
| Backend | Node.js, Express, TypeScript, Prisma ORM |
| Database | MySQL (`ecommerce_poc`) |
| Payments | Razorpay, **test mode** |
| Tests | Jest, Supertest |

The root README still says PostgreSQL in places. The real database is MySQL.

### 2.2 Folder layout

```
ecommerce-poc/
├── frontend/                  React app (http://localhost:5173)
│   └── src/
│       ├── pages/             Home, ProductDetail, Cart, Checkout, Payment,
│       │                      PaymentResult, OrderConfirmation, OrderDetails, NotFound
│       ├── components/        layout/Layout (nav), ui/ProductCard
│       ├── hooks/useCart.tsx  cart state (shared via a Context provider)
│       ├── services/          Axios API calls
│       └── types/
├── backend/                   Express API (http://localhost:5000)
│   ├── src/
│   │   ├── app.ts, index.ts
│   │   ├── routes/            productRoutes, orderRoutes, paymentRoutes
│   │   ├── controllers/       productController, orderController, paymentController
│   │   ├── services/          orderService  (added)
│   │   ├── ucp/               all UCP code  (added)
│   │   ├── middleware/, validators/, utils/ (prisma, razorpay)
│   ├── prisma/                schema.prisma, migrations, seed.ts
│   ├── ucp-schemas/           official UCP schemas (added, vendored)
│   ├── scripts/               UCP setup, client, demo (added)
│   ├── tests/                 payments, products, ucp
│   └── docs/UCP.md            UCP technical documentation (added)
└── PROJECT_REPORT.md          this file
```

### 2.3 Database tables

| Table | Purpose |
|---|---|
| `Category` | Men, Women, Kids, Accessories |
| `Product` | name, slug, description, `pricePaise`, images (JSON), `stock`, `active`, category |
| `Order` | order number, customer name/email/phone/address, subtotal, total, `status` (`PENDING`, `PAID`, `FAILED`, `CANCELLED`) |
| `OrderItem` | product, quantity, price at order time |
| `Payment` | one per order: Razorpay order/payment ids, signature, amount, `status` (`CREATED`, `ATTEMPTED`, `PAID`, `FAILED`, `REFUNDED`) |
| `CheckoutSession` | **added for UCP**: one row per UCP checkout, linked to an `Order` once completed |
| `IdempotencyRecord` | **added for UCP**: stored results of repeated requests |

All money is stored as integers in **paise** (₹1 = 100 paise). The seed data has 15 products across four categories.

### 2.4 How the normal shopping flow works

1. **Browse.** Home calls `GET /api/products` (search, category filter, sort, pagination). Product detail calls `GET /api/products/:id`.
2. **Cart.** Kept in the browser's localStorage by `useCart`. Stock is checked in the browser as a convenience only.
3. **Checkout.** The buyer enters name, email, phone, address. The page calls `POST /api/checkout`. The server re-reads every price and the stock from MySQL, and creates a `PENDING` order, its items and a `CREATED` payment row. The browser's prices are never trusted.
4. **Payment.** The `/payment/:orderId` page calls `POST /api/payments/create-order`. The server creates a Razorpay order for the amount stored in the database. The page opens Razorpay Checkout, where the card data goes to Razorpay and never to this server.
5. **Verification.** After payment, the page calls `POST /api/payments/verify`. The server checks the signature, asks Razorpay for the payment's status, then marks the order `PAID` and reduces stock. Razorpay can also call `POST /api/payments/webhook`.
6. **Confirmation.** `/order-confirmation/:orderId` and `/order/:orderId` read `GET /api/orders/:orderId`.

There is **no login**, and there is **no page that lists orders**. Order pages are reached only by their direct link (see section 10).

---

## 3. What was done, in order

### 3.1 Add to Cart not working

**Cause.** `useCart` was an ordinary hook. Every component that called it got its **own separate copy** of the cart. Clicking Add to Cart on a product changed only that component's copy, so the header count and Cart page never saw it. Each copy also wrote to localStorage and could overwrite the others.

**Fix.**
- `hooks/useCart.ts` became `hooks/useCart.tsx`. It now has a `CartProvider` (React Context) and `useCart()` reads from it. Existing imports did not change.
- `main.tsx` wraps the app in `<CartProvider>`.
- `addToCart` now returns `true/false`, so the product page only says "added" when it really was.
- The "Not enough stock" alert no longer appears twice (it had been fired inside a state updater, which React StrictMode runs twice).
- Product cards show a green "✓ Added to Cart" for two seconds with a "View Cart" link. Before, a working click looked like nothing happened.

I restarted the dev servers for you. I did not click through the result in a browser myself.

### 3.2 "Failed to create Razorpay order"

**Cause.** `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in `backend/.env` were still placeholders. Razorpay answered `401 Authentication failed`, and the backend turned that into a generic 500.

**Fix (done by you).** Generate test keys in the Razorpay dashboard (Test Mode → API Keys), put them in `.env`, restart the backend. After you did this the payment flow worked for your earlier orders.

### 3.3 UCP implementation

Described in full in section 4. Short version: discovery profile, five checkout operations, security headers and signatures, idempotency, a server-side price and stock check, Razorpay hand-off, tests, a live demo and documentation.

### 3.4 Payment hardening

While reading the existing payment code to reuse it, I found problems that made the UCP payment requirements impossible to meet. I fixed them:

| Problem found | Fix |
|---|---|
| The webhook accepted requests **with no signature**. Anyone could mark an order paid. | A valid `X-Razorpay-Signature` over the raw body is now required. |
| `verify` did not check that the Razorpay order belonged to this order. A signature from a cheap order could be replayed against an expensive one. | It now checks the Razorpay order id stored for this order. |
| `verify` trusted the signature alone. | It now also fetches the payment from Razorpay and requires status `captured`, the right order, amount and currency. |
| A forged signature set the order to `FAILED` for anyone who knew the order id. | A forged signature now changes nothing. |
| Stock was checked then reduced in two steps (a race), and the webhook could reduce it twice. | One shared function, `markOrderPaid`: a conditional `PENDING → PAID` update lets only one caller win, and stock is reduced with `UPDATE … WHERE stock >= qty`. |

Existing tests had a syntax typo (`mPrisma.\`) and did not compile. I fixed it and updated their mocks to match.

### 3.5 Order visibility investigation (no changes made)

You asked why an order created through UCP is not visible on the website. I looked at the database, the existing API and the existing pages, and reported the root cause and a proposal before touching any file. That proposal is waiting for your answer (section 10).

---

## 4. How UCP was created

### 4.1 What UCP is, in plain words

UCP is a standard way for an AI shopping assistant ("platform") to talk to a store ("business"): find out what the store can do, build a cart, and send the buyer to pay. This project implements the **store side** only.

### 4.2 Research and decisions

I read the official specification and the official repository instead of guessing:
- <https://ucp.dev/2026-01-23/specification/overview/>, `/checkout/`, `/checkout-rest/`, and the payment-handler guide
- The `Universal-Commerce-Protocol/ucp` repository, git tag `v2026-01-23`, and the `conformance` repository

Decisions that came out of that reading:

| Decision | Reason |
|---|---|
| Use release **2026-01-23**; payloads carry version string **`2026-01-11`** | The schemas in that release declare `2026-01-11` (the date of the last breaking change). Both values are constants in `src/ucp/config.ts`. |
| **REST** transport and the **checkout** capability only | Smallest real subset. Nothing is advertised that does not exist. |
| Product information stays on `GET /api/products` | This spec release has **no catalog capability**. |
| **No payment handler advertised** (`payment_handlers: {}`) | Razorpay is not a UCP payment handler, and I did not invent one. |
| `complete` returns `complete_in_progress` plus a `continue_url` to the existing Razorpay page | The spec expects a payment credential from a UCP payment handler. We hand the buyer to the trusted Razorpay UI instead. The checkout becomes `completed` only after server-side verification. |
| Vendor the official schemas into `ucp-schemas/` | Tests validate our responses against the real files. |

### 4.3 Building blocks

**Database (two new tables, additive migration).** I generated the migration without applying it, read the SQL (two `CREATE TABLE`, one foreign key on a new table), then applied it with `prisma migrate deploy`, which never resets data. Existing tables and rows were not touched.

**Discovery.** `GET /.well-known/ucp` returns the profile: version, the REST endpoint (`<base>/ucp/v1`), the checkout capability, and empty payment handlers. It validates against the official profile schema.

**Checkout API** (all under `/ucp/v1`):

| Operation | Request |
|---|---|
| Create | `POST /checkout-sessions` |
| Get | `GET /checkout-sessions/{id}` |
| Update (full replacement) | `PUT /checkout-sessions/{id}` |
| Complete | `POST /checkout-sessions/{id}/complete` |
| Cancel | `POST /checkout-sessions/{id}/cancel` |

**Server-side rules.**
- The client may send only a product id and a quantity. Prices, titles, currency (`INR`) and totals always come from MySQL. A client-supplied price of 1 paise is ignored.
- Quantity must be a whole number from 1 to 100; at most 50 lines; an unknown product is rejected with 400.
- A session needs the buyer's email, phone (E.164) and a name before it is `ready_for_complete`.
- Stock is re-checked at update and at complete. Insufficient stock gives an `out_of_stock` message, and completing is refused with 409.
- Sessions expire after 6 hours (the spec default).
- A platform can only see its own sessions; anyone else's id gives 404.

**Status model.** `incomplete → ready_for_complete → complete_in_progress → completed`, plus `canceled`. The status is partly stored and partly derived from the linked order: order `PAID` shows as `completed`; order `PENDING` shows as `complete_in_progress`; order `FAILED` or `CANCELLED` shows as `canceled`.

**Complete.** One database transaction does the following: re-check stock, claim the session with a conditional update (exactly one concurrent caller can win), and create one `PENDING` order priced from the database. Repeating or racing `complete` returns the same order and never a second one. After payment starts, cancel is refused (409), because money may be in flight.

**Security on every `/ucp/v1` request.**

| Layer | Behaviour |
|---|---|
| Rate limit | Per IP per minute, then 429 |
| Required headers | `UCP-Agent` (RFC 8941 `profile="…"`), `Request-Id` (UUID), `Idempotency-Key` (UUID, on POST/PUT) → otherwise 400 |
| Platform registry | Unregistered platform → 403 |
| API key | `X-API-Key`, compared as a SHA-256 hash in constant time → otherwise 401 |
| Request signature | `Request-Signature` is a detached JWS (RFC 7797, ES256) over the exact body bytes, checked against the platform's registered public key → otherwise 401 |
| Idempotency | Same key and same body replays the stored response; same key and different body returns 409. Stored in MySQL, kept 48 hours |
| Errors | `{ ucp, messages:[{type, code, content, severity, path?}] }`, never a stack trace |

Platform keys are **pre-registered** (`npm run ucp:setup`), not fetched from the `UCP-Agent` URL. Fetching a URL supplied by the caller would be a server-side request forgery risk.

**Razorpay integration.** The existing `create-order`, `verify` and `webhook` endpoints are reused, hardened as in section 3.4, and both `verify` and the webhook go through one function, `markOrderPaid`. The shared helper `createPendingOrder` is now used by both the website's checkout and the UCP complete.

### 4.4 Tests and tools created

- `tests/ucp.test.ts`: **54 integration tests** against the real MySQL database (own rows, removed afterwards) with Razorpay mocked. Responses are validated against the **official** `checkout.json` schema and the discovery profile against the official profile schema.
- `scripts/ucp-setup.ts`: registers a local test platform (ES256 key pair and API key).
- `scripts/ucp-demo.ts`: live walkthrough of the test plan, printing each step.
- `scripts/ucp-call.ts`: one signed request from the command line, or prints an equivalent `curl`.
- The official conformance suite was cloned into a scratch folder and run (results in section 7).

### 4.5 Flow, end to end

```
Customer: "buy me a Canvas Backpack"
   │
   ▼
AI client ("platform", external, not in this repo)
   ├─ GET  /.well-known/ucp                    what can this store do?
   ├─ GET  /api/products                       what is for sale?
   ├─ POST /ucp/v1/checkout-sessions           create (server prices it)
   ├─ PUT  /ucp/v1/checkout-sessions/{id}      add buyer, change quantity
   └─ POST /ucp/v1/checkout-sessions/{id}/complete
              → creates ONE PENDING order, status complete_in_progress, continue_url
   ▼
Buyer opens continue_url → /payment/{orderId} → Razorpay Checkout (test mode)
   ▼
POST /api/payments/verify  (and/or webhook)
   signature + Razorpay status fetch + amount match → order PAID, stock reduced
   ▼
GET /ucp/v1/checkout-sessions/{id}  → status completed, order {id, permalink_url}
```

Who is responsible for what:

| Part | What it is |
|---|---|
| Existing e-commerce | Products, orders, React UI, Razorpay |
| New UCP endpoints | Discovery plus the checkout REST API |
| UCP protocol conformance | Partial (see section 9) |
| Razorpay | Order creation, signature, status, webhook |
| External AI platform | **Not included.** `scripts/ucpClient.ts` only imitates one for demos |

---

## 5. File inventory

### Added

| File | Purpose |
|---|---|
| `backend/src/ucp/config.ts` | Spec version, capability names, spec URLs, env settings |
| `backend/src/ucp/profile.ts` | Builds and serves the discovery profile |
| `backend/src/ucp/routes.ts` | The five REST operations and the middleware chain |
| `backend/src/ucp/middleware.ts` | Raw body, headers, API key, signature, idempotency, error handler |
| `backend/src/ucp/checkoutService.ts` | Create/get/update/complete/cancel, validation, totals, status |
| `backend/src/ucp/errors.ts` | UCP error shape |
| `backend/src/ucp/platforms.ts` | Registry of platforms allowed to call the API |
| `backend/src/services/orderService.ts` | `createPendingOrder`, `markOrderPaid` |
| `backend/prisma/migrations/20261026095545_ucp_checkout_sessions/` | The two new tables |
| `backend/ucp-schemas/` | Official UCP schemas, unmodified (Apache-2.0) |
| `backend/scripts/ucp-setup.ts`, `ucpClient.ts`, `ucp-call.ts`, `ucp-demo.ts` | Setup, signing client, manual call, live demo |
| `backend/tests/ucp.test.ts` | 54 UCP tests |
| `backend/docs/UCP.md` | Technical UCP documentation |
| `PROJECT_REPORT.md` | This report |

### Modified

| File | Change |
|---|---|
| `frontend/src/hooks/useCart.ts` → `useCart.tsx` | Context-based shared cart |
| `frontend/src/main.tsx` | Wraps the app in `CartProvider` |
| `frontend/src/components/ui/ProductCard.tsx` | "Added to Cart" feedback and link |
| `frontend/src/pages/ProductDetail.tsx` | Confirms only on a real add |
| `backend/src/app.ts` | Mounts `/.well-known/ucp` and `/ucp/v1` before the browser CORS policy |
| `backend/src/controllers/orderController.ts` | Uses the shared `createPendingOrder` (behaviour unchanged) |
| `backend/src/controllers/paymentController.ts` | `verify` and webhook hardening |
| `backend/prisma/schema.prisma` | Two new models and a back-relation on `Order` (no column changes) |
| `backend/tests/payments.test.ts`, `products.test.ts` | Typo fix and mock updates |
| `backend/.env.example` | Correct MySQL URL, Razorpay and UCP variables |
| `backend/package.json` | New dependencies (`jose`, `express-rate-limit`, dev: `ajv`, `ajv-formats`) and `ucp:*` scripts |
| `README.md` | Pointer to the UCP documentation |
| `/.gitignore` | Ignores the local UCP keys and registry |

### Local-only secrets (git-ignored, not in the repo)

- `backend/.env`: database password and Razorpay keys
- `backend/ucp-platforms.json`: API-key **hash** and public key
- `backend/.ucp-test-platform/credentials.json`: the test platform's **private key and API key**

---

## 6. How to run and test

### First-time setup

```powershell
cd E:\POC\ecommerce-poc\backend
npm install
npx prisma migrate deploy
npx prisma generate        # stop the backend first on Windows; it locks the engine file
npm run ucp:setup          # registers the local test platform
```

`backend/.env` needs your `DATABASE_URL`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`. If the database password contains `@`, write it as `%40` in the URL.

### Start

```powershell
# terminal 1
cd E:\POC\ecommerce-poc\backend;  npm run dev      # http://localhost:5000
# terminal 2
cd E:\POC\ecommerce-poc\frontend; npm run dev      # http://localhost:5173
```

### Test

```powershell
npm test                   # all 61 backend tests (real DB, Razorpay mocked)
npm run test:ucp           # the 54 UCP tests only
npm run ucp:demo           # live UCP walkthrough (no payment)
npm run ucp:demo -- --pay  # also creates an order; prints a pay link; waits for your test payment
```

Razorpay test card: `4111 1111 1111 1111`, any future expiry, any CVV, any OTP.

### One manual signed request

Put this in `body.json`: `{"line_items":[{"item":{"id":"<product-id>"},"quantity":2}]}`

```powershell
npm run ucp:call -- POST /checkout-sessions @body.json
npm run ucp:call -- GET /checkout-sessions/<id>
npm run ucp:call -- POST /checkout-sessions @body.json --curl   # prints a signed curl
```

In Git Bash, set `MSYS_NO_PATHCONV=1` first, otherwise `/checkout-sessions` is rewritten into a Windows path. A Postman collection is not provided: the request signature cannot be produced reliably in Postman's scripting sandbox.

---

## 7. Test results

All figures are from real runs.

| Check | Result |
|---|---|
| `npm test` (existing and UCP) | **3 suites, 61 tests, 61 passed** |
| `tests/ucp.test.ts` | 54 passed, including schema validation against the official schemas |
| `npm run ucp:demo` against the running server | All checks passed (discovery, product info, create, get, update, price tampering, invalid input, idempotency, header/auth/signature rejection, forged payment verification, cancel) |
| Test data left in the database by the tests | None (checked: still 15 products and the original orders) |
| A real payment through Razorpay in a browser, via UCP | **Not run by me.** Run `npm run ucp:demo -- --pay` |
| Official conformance suite | **1 passed, 61 failed, 15 skipped** |

**Reading the conformance number.** It does not mean 61 requirements are broken.
1. The official suite calls with its own mock agent, **no API key**, and the literal header `request-signature: test`. This server correctly answers `403 unknown_platform` or `401`. I did not add an "authentication off" mode to make it pass.
2. It targets a newer release (`2026-04-08`) than the one used here.
3. It tests capabilities this project does not implement (fulfillment, discount, order, buyer consent).

The one test that passes is discovery.

What the automated tests cover for payments: a forged signature changes nothing; a valid signature for another order is refused; a wrong amount is refused; a failed or merely authorized payment is not marked paid; Razorpay being unreachable does not mark it paid; a failed attempt can be retried; a repeated webhook or verify reduces stock only once; two buyers racing for the last unit never push stock below zero.

---

## 8. Security notes

**In place**
- Prices and totals are always read from the database. The client's values are ignored.
- Card data never touches this server. Razorpay secrets stay on the server.
- Payment is confirmed three ways before an order becomes `PAID`: HMAC signature, Razorpay's own payment record, and an amount and order match.
- Webhooks must be signed.
- Stock changes are atomic.
- UCP calls need a registered platform, an API key and a valid signature. Duplicates are handled safely.

**Weak spots that remain**
- `GET /api/orders/:orderId` returns the whole payment row to anyone holding the order id. That includes `razorpaySignature` and `raw` (the full Razorpay response). Fixing it is part of the pending proposal (section 10).
- `POST /api/payments/create-order` has no authentication and creates a new Razorpay order on every call. It was like this before; I did not change it.
- The request signature covers only the body (not the method, path or time). Replays are limited by HTTPS and idempotency.
- `backend/.env` contains real secrets. It is git-ignored; do not commit or share it.
- The local test platform's private key and API key sit in `backend/.ucp-test-platform/`. They are for local testing only. Rotate with `npm run ucp:setup -- --force`.

---

## 9. Open items and limitations

**UCP and protocol**
- **Not conformant overall.** Only REST checkout is implemented. Fulfillment, discount, order webhooks, buyer consent, AP2, MCP, A2A and embedded checkout are not.
- **No UCP payment handler.** `complete` does not accept a payment instrument; it is read as an object and never stored. The spec says payment is required on complete, so this is a documented deviation. `complete` also returns `complete_in_progress`, not `completed`.
- **The `Request-Signature` format is my interpretation.** This spec release marks the header required but only defines a format for webhooks. I applied the webhook format (detached JWT, ES256) to requests.
- **Plain HTTP locally.** The spec requires HTTPS (TLS 1.3), and `continue_url` should be an absolute HTTPS URL. Set `UCP_PUBLIC_BASE_URL` and `FRONTEND_URL` to https URLs (for example through a tunnel) for a real handoff.
- Authentication is API key plus signature. OAuth bearer tokens and mutual TLS are not implemented.
- `continue_url` appears only once an order exists. There is no page to resume an unfinished checkout.
- The legal links in every checkout point at `/terms` and `/privacy` on your frontend, and those pages do not exist yet.

**Commerce and payments**
- **Stock is not reserved** between `complete` and payment. If two buyers pay for the last unit, the second is refused after Razorpay may already have captured the money, so that needs a manual refund. Refund handling is not built.
- Pending UCP orders never expire on their own, and no job cleans up stale pending orders.
- **UCP orders store a placeholder delivery address.** Without the fulfillment capability, the protocol has no address field. A real shop must collect one.
- No tax, shipping or discounts: total equals subtotal.
- The webhook handles `payment.captured`, `order.paid` and `payment.failed`. A failed payment marks the payment `FAILED` but leaves the order `PENDING` so the buyer can retry.
- The rate limiter is in memory, per IP, single instance.

**Application (pre-existing)**
- No login, no admin area and no order list.
- The root README mentions PostgreSQL; the database is MySQL.

**To make this usable with a real AI assistant** you would still need: a public HTTPS URL; onboarding with each platform (they decide which merchants to trust); a real UCP payment handler (Razorpay would need a published one, or one from a payment provider); the missing capabilities; and the legal and operational basics (terms, refunds, support, hosting, monitoring). A local `/.well-known/ucp` does **not** connect your site to ChatGPT or any other assistant by itself.

---

## 10. The pending order-visibility proposal

### What you asked
Order `8bb4640a-3a4c-428c-9bbf-648456eef2c1`, created through UCP, was not visible on the website. Login is not implemented, and no login is to be added.

### What I found (read-only; no files or data changed)
- The order **exists**: `ORD-1793012761215-600937`, Canvas Backpack × 1, ₹2,999.00, created 26 Oct 2026 11:06.
- **Order status `PENDING`, payment status `CREATED`.** No Razorpay order, payment id or signature exists. It was never paid and has not been marked paid. This is correct: the buyer never opened the payment link.
- It is linked to UCP session `chk_906e45e0…`, which is `complete_in_progress`.

### Root cause
The website has **no order listing page and no admin page**. The only order API is `GET /api/orders/:orderId`, and the only order pages are reached by direct link (`/order/:orderId`, `/payment/:orderId`). A website order is visible because checkout sends the buyer to its page. A UCP order is created by the AI client, so the browser never gets that link. Nothing is wrong with the order or with UCP.

You can see it now by opening:
- `http://localhost:5173/order/8bb4640a-3a4c-428c-9bbf-648456eef2c1` (details)
- `http://localhost:5173/payment/8bb4640a-3a4c-428c-9bbf-648456eef2c1` (to pay it)

### Proposed change (smallest, no login, no schema change)
1. **`GET /api/orders` (read-only list).** Newest first, with pagination and an optional status filter. Per row: order id, order number, customer name, total, order status, payment status, item count, created time, and `source` (`ucp` or `website`, taken from whether a `CheckoutSession` is linked). **No** email, phone, address or any Razorpay field.
2. **A new `/orders` page** with a nav link; each row links to the existing `/order/:orderId`, and a `PENDING` order gets a "Pay now" link to `/payment/:orderId`.
3. **Trim `GET /api/orders/:orderId`** so it stops returning `razorpaySignature` and `raw`. The existing details and confirmation pages do not show them.
4. **Tests** for the list (ordering, filter, no sensitive fields, source flag) and for the trimmed detail response.

Because there is no login, that page would be open to anyone who can reach the site. It is therefore a POC-only page, and the list deliberately leaves out customer details.

**Status: not implemented.** Waiting for your decision: all four steps, or only steps 1 and 2.

---

## 11. Where to find more

| Need | File |
|---|---|
| UCP technical detail, endpoint table, expected responses, manager demo script | `backend/docs/UCP.md` |
| Environment variables | `backend/.env.example` |
| Official UCP schemas used | `backend/ucp-schemas/` |
| The UCP tests | `backend/tests/ucp.test.ts` |
| This report | `PROJECT_REPORT.md` |

External references: <https://ucp.dev/> and <https://github.com/Universal-Commerce-Protocol/ucp>.
