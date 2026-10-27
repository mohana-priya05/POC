# Website AI Shopping Chatbot (Gemini + UCP + Razorpay)

## What it is
A floating chat window on every page of the site. The shopper talks to a Gemini assistant, picks a product and quantity, enters buyer details, and pays with Razorpay, all inside the chat.

## Architecture
```
Browser chat UI ──/api/chat/message──▶ Gemini (server side; key never leaves the backend)
      │                                   └─ tools: search_products, list_categories (read-only, MySQL)
      │
      └─/api/chat/checkout[...]──▶ chat routes ──signed HTTP──▶ /ucp/v1/checkout-sessions...  (existing UCP API)
                                    (acts as registered UCP platform "website-chat-assistant":
                                     API key + ES256 request signature + Idempotency-Key)
      │
      └─ Razorpay modal ──▶ existing /api/payments/create-order and /verify (HMAC + Razorpay fetch + amount check)
```

Why the chat backend is a UCP platform: UCP requires an API key and a request signature, which can never live in a browser. The chat routes hold the platform credentials server-side and call `/ucp/v1` over loopback HTTP, so authentication, signatures, idempotency and validation are all exercised, not bypassed.

## Files
| File | Role |
|---|---|
| `backend/src/chat/gemini.ts` | Gemini REST call, function-calling loop, retry on 429/500/503 |
| `backend/src/chat/productSearch.ts` | Catalogue search used by the tools (prices/stock from MySQL) |
| `backend/src/chat/ucpPlatformClient.ts` | Signing UCP client (credentials from env or `.ucp-test-platform/chat-credentials.json`) |
| `backend/src/chat/routes.ts` | `/api/chat/*` endpoints, validation, rate limit, response view |
| `backend/scripts/ucp-register-chat.ts` | Registers the chatbot platform (`npm run ucp:register-chat`) |
| `frontend/src/components/chat/ChatWidget.tsx` | Floating icon and chat window |
| `frontend/src/components/chat/ChatProductCard.tsx` | Product card: image, price, stock, quantity picker, Buy now |
| `frontend/src/components/chat/CheckoutCard.tsx` | Checkout steps and Razorpay |
| `frontend/src/services/chatService.ts` | API client |
| `backend/tests/chat.test.ts` | 24 tests |

## Endpoints
| Endpoint | UCP call made |
|---|---|
| `POST /api/chat/message` | none (Gemini + catalogue search) |
| `POST /api/chat/checkout` `{productId, quantity, requestId}` | `POST /checkout-sessions` |
| `PATCH /api/chat/checkout/:id` `{quantity?, buyer?}` | `GET` then `PUT /checkout-sessions/:id` |
| `POST /api/chat/checkout/:id/complete` | `POST .../complete` |
| `POST /api/chat/checkout/:id/cancel` | `POST .../cancel` |
| `GET /api/chat/checkout/:id` | `GET /checkout-sessions/:id` + order row from MySQL |

## Trust rules
- Gemini can only read the catalogue. It has no tool for carts, checkout, orders or payments. Product cards (price, stock) are rendered from tool results, never from model text.
- Quantity comes from the stepper the shopper uses; it is validated (integer 1-100) and checked against stock by UCP.
- Orders are shown as paid only when MySQL says `Order.status = PAID` and `Payment.status = PAID`, which only happens after the existing server-side verification (HMAC signature, Razorpay payment fetched and `captured`, amount and order matched).
- Double clicks: the UI sends a per-click `requestId` used as the UCP Idempotency-Key; `complete` uses a key derived from the checkout id. Complete is also atomic in UCP, so there is one order and one stock deduction.
- The chat view never returns Razorpay ids/signatures or the order's customer contact details.

## Setup
1. `backend/.env`: `GEMINI_API_KEY`, optionally `GEMINI_MODEL` (default `gemini-3.5-flash`; `gemini-2.5-flash` is no longer available to new keys).
2. `npm run ucp:register-chat` once (adds the chatbot to `ucp-platforms.json`, keeps other platforms; no restart needed).
3. `npm run dev` in backend and frontend; open the site and click the chat icon.

## Limits
- UCP has no address field, so chat orders store the same placeholder address as other UCP orders.
- All chat traffic reaches UCP from loopback, so UCP's per-IP limit (`UCP_RATE_LIMIT_PER_MIN`, default 120) is shared by all shoppers. `/api/chat` has its own per-IP limit (`CHAT_RATE_LIMIT_PER_MIN`, default 60).
- Chat history lives in the page; a browser refresh clears it. A started checkout can still be paid via `/payment/<orderId>`.
- Sessions are unguessable ids (128-bit); anyone holding an id can act on that checkout through the chat API. There is no login in this POC.
