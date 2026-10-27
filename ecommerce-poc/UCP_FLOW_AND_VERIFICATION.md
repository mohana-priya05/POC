# UCP Integration: Flow, Files and Verification Guide

Written for: you (the developer), to understand and verify the UCP integration end to end.

---

## 1. Files and how UCP was implemented

All UCP code is **added**, not rewritten. The existing shop was reused.

| Area | File | Role |
|---|---|---|
| Wiring | `backend/src/app.ts` | Mounts `GET /.well-known/ucp` and `/ucp/v1/*` before the browser CORS policy and `express.json()` (UCP needs the raw body for signatures) |
| Config | `backend/src/ucp/config.ts` | Spec version constants, capability names, env settings |
| Discovery | `backend/src/ucp/profile.ts` | `buildProfile()`, `discoveryHandler` |
| Routes | `backend/src/ucp/routes.ts` | `createUcpRouter()`: middleware chain and the 5 checkout operations |
| Security | `backend/src/ucp/middleware.ts` | `createRateLimiter`, `parseBody`, `requireHeaders`, `authenticate`, `verifySignature`, `idempotency`, `errorHandler` |
| Platforms | `backend/src/ucp/platforms.ts` | Registry of allowed callers (API-key hash and public key) |
| Business logic | `backend/src/ucp/checkoutService.ts` | `createCheckout`, `getCheckout`, `updateCheckout`, `completeCheckout`, `cancelCheckout` |
| Errors | `backend/src/ucp/errors.ts` | `UcpError`, UCP error body shape |
| Shared order logic | `backend/src/services/orderService.ts` | `createPendingOrder` (used by website checkout **and** UCP complete), `markOrderPaid` (used by verify **and** webhook) |
| Payments (existing, hardened) | `backend/src/controllers/paymentController.ts` | `createOrder`, `verifyPayment`, `webhook` |
| Orders (existing) | `backend/src/controllers/orderController.ts` | `checkout` (website), `getOrder` |
| Database | `backend/prisma/schema.prisma` + migration `20261026095545_ucp_checkout_sessions` | New tables `CheckoutSession`, `IdempotencyRecord` |
| Tools | `backend/scripts/ucp-setup.ts`, `ucpClient.ts`, `ucp-call.ts`, `ucp-demo.ts` | Register a test platform, sign requests, run the demo |
| Tests | `backend/tests/ucp.test.ts` | 54 tests |

Implementation in one paragraph: UCP is a thin protocol layer over your existing shop. Each UCP request is rate-limited, authenticated (registered platform, API key, detached ES256 signature over the exact body), de-duplicated (idempotency), then handed to `checkoutService`. The service reads prices and stock from MySQL (never from the caller), stores a `CheckoutSession`, and on `complete` creates a normal `PENDING` order through the same `createPendingOrder` the website uses. Payment then goes through the existing Razorpay endpoints.

---

## 2. The flow, step by step

```
AI agent / ucp-demo script                      Your backend                         MySQL / Razorpay
-------------------------                       ------------                         ----------------
1 GET /.well-known/ucp                    ->    profile.ts                           (none)
2 GET /api/products                       ->    productController                    Product
3 POST /ucp/v1/checkout-sessions          ->    createCheckout                       CheckoutSession (status incomplete)
4 PUT  /ucp/v1/checkout-sessions/{id}     ->    updateCheckout (add buyer)           CheckoutSession (ready_for_complete)
5 POST /ucp/v1/checkout-sessions/{id}/complete -> completeCheckout                   Order PENDING + OrderItem + Payment CREATED,
                                                 returns complete_in_progress         CheckoutSession.orderId set
                                                 + continue_url
6 Buyer opens continue_url (/payment/{orderId})
7 Frontend POST /api/payments/create-order ->   paymentController.createOrder        Razorpay order created, Payment.razorpayOrderId
8 Razorpay Checkout popup, test card
9 Frontend POST /api/payments/verify      ->    verifyPayment: HMAC check,           Razorpay payments.fetch (must be captured),
                                                 fetch payment, amount match,         then markOrderPaid:
                                                 markOrderPaid                        Order PAID, Payment PAID, Product.stock reduced
10 GET /ucp/v1/checkout-sessions/{id}     ->    render(): status derived from Order  status = completed
```

Key points:
- **Prices:** the agent may send only a product id and quantity. Any price it sends is ignored.
- **`complete` does not take payment.** Razorpay is not a UCP payment handler, so `complete` creates the pending order and returns a `continue_url` to the existing Razorpay page. The checkout becomes `completed` only when the linked order is `PAID`, verified server side.
- **Status mapping** (`render()` in `checkoutService.ts`): order PENDING -> `complete_in_progress`; PAID -> `completed`; FAILED or CANCELLED -> `canceled`.
- **Exactly one order** per session: `complete` claims the session with a conditional update, so repeats or races return the same order.

---

## 3. Backend APIs, services and tables involved

**APIs**

| API | Purpose |
|---|---|
| `GET /.well-known/ucp` | Discovery profile |
| `POST /ucp/v1/checkout-sessions` | Create |
| `GET /ucp/v1/checkout-sessions/:id` | Get |
| `PUT /ucp/v1/checkout-sessions/:id` | Update (full replacement) |
| `POST /ucp/v1/checkout-sessions/:id/complete` | Create the pending order |
| `POST /ucp/v1/checkout-sessions/:id/cancel` | Cancel (refused once a Razorpay order exists) |
| `GET /api/products` | Product info (this UCP release has no catalog capability) |
| `POST /api/payments/create-order` | Create Razorpay order |
| `POST /api/payments/verify` | Verify payment, mark PAID |
| `POST /api/payments/webhook` | Razorpay server-to-server confirmation (signed) |
| `GET /api/orders/:orderId` | Order details |

**Tables**: `Product`, `Order`, `OrderItem`, `Payment` (existing); `CheckoutSession`, `IdempotencyRecord` (new).

---

## 4. Verify orders and payment status in MySQL

Open MySQL (Workbench or `mysql -u <user> -p ecommerce_poc`).

**a) Latest orders with payment status**
```sql
SELECT o.id, o.orderNumber, o.status AS order_status, o.totalPaise/100 AS total_inr,
       p.status AS payment_status, p.razorpayOrderId, p.razorpayPaymentId, o.createdAt
FROM `Order` o
JOIN Payment p ON p.orderId = o.id
ORDER BY o.createdAt DESC
LIMIT 10;
```

**b) Only orders created through UCP**
```sql
SELECT c.id AS checkout_id, c.status AS stored_status, c.platformProfile,
       o.id AS order_id, o.orderNumber, o.status AS order_status, p.status AS payment_status
FROM CheckoutSession c
JOIN `Order` o ON o.id = c.orderId
JOIN Payment p ON p.orderId = o.id
ORDER BY c.createdAt DESC;
```
Note: `c.stored_status` can lag. The status the API returns is derived from the order, so trust `order_status`.

**c) One specific order**
```sql
SELECT o.orderNumber, o.status, p.status AS payment_status, p.razorpayPaymentId
FROM `Order` o JOIN Payment p ON p.orderId = o.id
WHERE o.id = '<order-id>';
```

**d) Items in an order**
```sql
SELECT oi.orderId, pr.name, oi.quantity, oi.subtotalPaise/100 AS subtotal_inr
FROM OrderItem oi JOIN Product pr ON pr.id = oi.productId
WHERE oi.orderId = '<order-id>';
```

**e) Stock is reduced only after payment**
```sql
SELECT name, stock FROM Product WHERE id = '<product-id>';
-- run before and after paying; it drops by the ordered quantity only once the order is PAID
```

**f) Sessions without an order (not yet completed)**
```sql
SELECT id, status, expiresAt FROM CheckoutSession WHERE orderId IS NULL ORDER BY createdAt DESC;
```

**g) Sanity checks that nothing is wrong**
```sql
-- PAID order whose payment is not PAID (should return 0 rows)
SELECT o.id FROM `Order` o JOIN Payment p ON p.orderId = o.id WHERE o.status = 'PAID' AND p.status <> 'PAID';

-- more than one order per session is impossible (orderId is UNIQUE); idempotency keys stored
SELECT scope, idemKey, state, responseStatus, createdAt FROM IdempotencyRecord ORDER BY createdAt DESC LIMIT 10;
```

Expected lifecycle in the tables:

| Moment | Order | Payment | Checkout (API status) |
|---|---|---|---|
| After `complete` | PENDING | CREATED, no Razorpay ids | complete_in_progress |
| After `create-order` | PENDING | CREATED, `razorpayOrderId` set | complete_in_progress |
| After successful verify | PAID | PAID, `razorpayPaymentId` set | completed |
| Payment fails | PENDING (retry allowed) | FAILED | complete_in_progress |

---

## 5. Will the UCP product appear on the website's Cart page?

**No.** Reasons:
- The website cart lives in the **browser's localStorage** (`frontend/src/hooks/useCart.tsx`). It exists only on the shopper's own browser.
- The UCP script is a **separate server-to-server client**. It never touches your browser, so it cannot write to that localStorage.
- UCP does not use a cart at all. It creates a **checkout session** in MySQL, and on `complete` a real `Order`. The cart is a website-only convenience for building an order; a UCP agent skips that step.

Where you can see a UCP purchase instead: the order and payment pages by direct link, `/order/<orderId>` and `/payment/<orderId>` (the `continue_url` returned by `complete` is the payment link). There is currently no order list page, so UCP orders do not appear anywhere browsable. Adding a `GET /api/orders` list and an `/orders` page is the pending proposal (see `PROJECT_REPORT.md`, section 10).

---

## 6. Website checkout vs UCP agent checkout

| | Website checkout | UCP agent checkout |
|---|---|---|
| Who drives it | The human in a browser | An AI agent / program |
| Product choice | Cart in browser localStorage | Product ids and quantities in the API request |
| Entry call | `POST /api/checkout` | `POST /ucp/v1/checkout-sessions`, then `PUT`, then `/complete` |
| Pricing | Server reads DB | Server reads DB (same rule, plus a session you can re-fetch) |
| Caller identity | None (public) | Registered platform + API key + signed request |
| Safe retries | Not specified | Idempotency-Key required |
| Result of checkout | Order, redirect to payment page | Order and a `continue_url`; the agent hands it to the human |
| Payment | Same Razorpay page and verify | **Same** Razorpay page and verify |
| Order creation code | `createPendingOrder` | **Same** `createPendingOrder` |
| Progress tracking | Browser navigation | `GET` the session; status derived from the order |

So the two differ at the front door; after the order exists they share the same payment and verification code.

---

## 7. Verify everything: order, Razorpay test payment, verification, confirmation

**Prerequisites:** `backend/.env` has real Razorpay **test** keys; MySQL is running; one-time `npm run ucp:setup` done in `backend`.

**Step 1: start servers**
```powershell
cd E:\POC\ecommerce-poc\backend;  npm run dev      # http://localhost:5000
cd E:\POC\ecommerce-poc\frontend; npm run dev      # http://localhost:5173
```

**Step 2: discovery**
Open `http://localhost:5000/.well-known/ucp`. Expect JSON with only `dev.ucp.shopping.checkout` and `payment_handlers: {}`.

**Step 3: automated tests (no payment)**
```powershell
cd E:\POC\ecommerce-poc\backend
npm test                 # expect 3 suites, 61 passed
npm run ucp:demo         # expect ALL CHECKS PASSED
```

**Step 4: full flow with real Razorpay test payment**
```powershell
npm run ucp:demo -- --pay
```
The script creates a session, completes it (a `PENDING` order is created), prints a link, and waits up to 5 minutes.
1. Run SQL 4(a) or 4(b): the new order is `PENDING` / `CREATED`.
2. Open the printed link (`/payment/<orderId>`). Pay with test card `4111 1111 1111 1111`, any future expiry, any CVV, any OTP.
3. The page calls `/api/payments/verify`. The script then prints `checkout status completed`, `MySQL order status PAID`, and `payment record PAID with Razorpay ids`.
4. Run SQL 4(a) again: order `PAID`, payment `PAID`, `razorpayPaymentId` filled. Run 4(e): stock reduced once.
5. Open `http://localhost:5173/order-confirmation/<orderId>` to see the confirmation page.

**Step 5: negative checks (should all be rejected and change nothing)**
- Forged verify: `POST /api/payments/verify` with a fake signature returns 400, order stays `PENDING` (the demo checks this).
- Unsigned webhook: rejected 400/503.
- Complete twice: second call returns the same order, no duplicate (SQL 4(b) shows one row per session).
- Cancel after payment started: 409.

**Step 6: single manual request (optional)**
```powershell
npm run ucp:call -- GET /checkout-sessions/<id>
```
In Git Bash prefix with `MSYS_NO_PATHCONV=1`.

**What I have and have not verified:** the 61 tests and the live demo (without payment) were run and passed. I did **not** run a real browser Razorpay payment through the UCP flow; Step 4 is how you confirm it.
