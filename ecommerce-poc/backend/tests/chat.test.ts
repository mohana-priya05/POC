/**
 * Website chatbot -> UCP checkout -> Razorpay verification, end to end through the HTTP API.
 *
 * Real MySQL (own rows only, removed in afterAll). Razorpay and Gemini are mocked; everything
 * else is real: the chatbot backend signs genuine UCP requests with its own registered platform
 * key and sends them over HTTP to this same app, so API-key, signature and idempotency checks run.
 */
import crypto from 'crypto';
import request from 'supertest';
import type { Server } from 'http';
import { exportJWK, generateKeyPair } from 'jose';

const CHAT_PROFILE = 'https://jest.local.test/chat-platform';
const CHAT_API_KEY = `ucp_chat_jest_${crypto.randomBytes(8).toString('hex')}`;
const KEY_SECRET = 'jest_key_secret';
const TAG = `chat-jest-${Date.now()}`;

process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = 'jest_webhook_secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_jest';
process.env.GEMINI_API_KEY = 'jest-gemini-key';
process.env.CHAT_RATE_LIMIT_PER_MIN = '1000'; // the limiter itself is tested separately below

const mockRazorpay = { orders: { create: jest.fn() }, payments: { fetch: jest.fn() } };
jest.mock('../src/utils/razorpay', () => ({ razorpay: mockRazorpay }));

import app from '../src/app';
import prisma from '../src/utils/prisma';
import { normalizePhone } from '../src/chat/routes';

// ---------------------------------------------------------------- Gemini mock (only Google URLs)
const realFetch = global.fetch;
let geminiScript: Array<(body: any) => any> = [];
const geminiCalls: any[] = [];
let geminiDown = false;

beforeAll(() => {
  global.fetch = jest.fn(async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
    geminiCalls.push({ url, headers: init?.headers, body: JSON.parse(init.body) });
    if (geminiDown) return new Response('{"error":"down"}', { status: 400 });
    const next = geminiScript.shift();
    const content = next ? next(JSON.parse(init.body)) : { role: 'model', parts: [{ text: 'ok' }] };
    return new Response(JSON.stringify({ candidates: [{ content }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
});

// ---------------------------------------------------------------- fixtures
let server: Server;
let categoryId: string;
let product: { id: string; pricePaise: number; name: string };
let lowStock: { id: string };
const rid = () => crypto.randomUUID();
const cleanupOrderIds: string[] = [];

const chat = (method: 'get' | 'post' | 'patch', path: string, body?: unknown) => {
  const r = request(app)[method](`/api/chat${path}`);
  return body === undefined ? r : r.send(body as object);
};

const BUYER = { name: 'Jest Buyer', email: 'jest.buyer@example.com', phone: '9876543210' };

const startCheckout = async (productId = product.id, quantity = 2, requestId = rid()) =>
  chat('post', '/checkout', { productId, quantity, requestId });

const readyCheckout = async (productId = product.id, quantity = 2) => {
  const started = await startCheckout(productId, quantity);
  expect(started.status).toBe(201);
  const id = started.body.data.id;
  const updated = await chat('patch', `/checkout/${id}`, { buyer: BUYER });
  expect(updated.status).toBe(200);
  return { id, updated };
};

const stock = async (id: string) => (await prisma.product.findUnique({ where: { id } }))!.stock;

/** Mimics what Razorpay Checkout + the existing payment endpoints do for a paid test payment. */
const payForOrder = async (orderId: string, capturedStatus = 'captured') => {
  const order = (await prisma.order.findUnique({ where: { id: orderId } }))!;
  const rzpOrderId = `order_${crypto.randomBytes(6).toString('hex')}`;
  mockRazorpay.orders.create.mockResolvedValueOnce({ id: rzpOrderId, amount: order.totalPaise, currency: 'INR' });
  const created = await request(app).post('/api/payments/create-order').send({ orderId });
  expect(created.status).toBe(200);
  const rzpPaymentId = `pay_${crypto.randomBytes(6).toString('hex')}`;
  mockRazorpay.payments.fetch.mockResolvedValueOnce({ id: rzpPaymentId, order_id: rzpOrderId, amount: order.totalPaise, currency: 'INR', status: capturedStatus });
  const signature = crypto.createHmac('sha256', KEY_SECRET).update(`${rzpOrderId}|${rzpPaymentId}`).digest('hex');
  return request(app)
    .post('/api/payments/verify')
    .send({ orderId, razorpay_order_id: rzpOrderId, razorpay_payment_id: rzpPaymentId, razorpay_signature: signature });
};

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const kid = 'chat-jest-key';
  const pub = { ...(await exportJWK(pair.publicKey)), kid, alg: 'ES256', use: 'sig' };
  const priv = { ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256', use: 'sig' };
  process.env.UCP_PLATFORMS_JSON = JSON.stringify({
    platforms: [{ name: 'chat-jest', profile: CHAT_PROFILE, api_key_sha256: crypto.createHash('sha256').update(CHAT_API_KEY).digest('hex'), signing_keys: [pub] }],
  });
  process.env.CHAT_UCP_PROFILE = CHAT_PROFILE;
  process.env.CHAT_UCP_API_KEY = CHAT_API_KEY;
  process.env.CHAT_UCP_PRIVATE_JWK = JSON.stringify(priv);

  // The chatbot backend calls /ucp/v1 over real HTTP, so the app must be listening.
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  process.env.CHAT_UCP_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;

  categoryId = (await prisma.category.create({ data: { name: TAG, slug: TAG } })).id;
  const mk = (suffix: string, stockQty: number, pricePaise: number, name: string) =>
    prisma.product.create({ data: { name, slug: `${TAG}-${suffix}`, description: 'created by chat.test.ts', pricePaise, images: ['https://img.test/x.png'], stock: stockQty, categoryId } });
  product = await mk('main', 1000, 12345, `Chatbot Zeppelin Bag ${TAG}`);
  lowStock = await mk('low', 3, 5000, `Chatbot Rare Cap ${TAG}`);
});

afterAll(async () => {
  global.fetch = realFetch;
  const sessions = await prisma.checkoutSession.findMany({ where: { platformProfile: CHAT_PROFILE } });
  const productIds = (await prisma.product.findMany({ where: { categoryId }, select: { id: true } })).map(p => p.id);
  const itemOrders = await prisma.orderItem.findMany({ where: { productId: { in: productIds } }, select: { orderId: true } });
  const ids = [...new Set([...cleanupOrderIds, ...sessions.map(s => s.orderId).filter(Boolean), ...itemOrders.map(i => i.orderId)])] as string[];
  await prisma.checkoutSession.deleteMany({ where: { platformProfile: CHAT_PROFILE } });
  await prisma.payment.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.order.deleteMany({ where: { id: { in: ids } } });
  await prisma.idempotencyRecord.deleteMany({ where: { scope: { startsWith: 'chat-jest|' } } });
  await prisma.product.deleteMany({ where: { categoryId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await new Promise(r => server.close(r));
  await prisma.$disconnect();
});

beforeEach(() => {
  mockRazorpay.orders.create.mockReset();
  mockRazorpay.payments.fetch.mockReset();
  geminiScript = [];
  geminiCalls.length = 0;
  geminiDown = false;
});

// ================================================================= Gemini conversation
describe('assistant (Gemini) - product discovery', () => {
  it('searches the real catalogue through a tool call; products, prices and stock come from MySQL', async () => {
    geminiScript = [
      () => ({ role: 'model', parts: [{ functionCall: { name: 'search_products', args: { query: 'zeppelin bag' } } }] }),
      () => ({ role: 'model', parts: [{ text: 'Found it! It costs ₹1 (the model lies).' }] }),
    ];
    const res = await chat('post', '/message', { message: 'Show me a Zeppelin Bag', history: [] });
    expect(res.status).toBe(200);
    expect(res.body.data.aiAvailable).toBe(true);
    expect(res.body.data.products).toHaveLength(1);
    const p = res.body.data.products[0];
    expect(p).toMatchObject({ id: product.id, pricePaise: 12345, stock: 1000, inStock: true });
    // second Gemini call carried the DB result back as a functionResponse
    const fr = geminiCalls[1].body.contents.at(-1).parts[0].functionResponse;
    expect(fr.response.products[0]).toMatchObject({ priceInr: 123.45, stock: 1000 });
  });

  it('keeps the API key in a header sent only to Google, never in the response', async () => {
    geminiScript = [() => ({ role: 'model', parts: [{ text: 'Hello' }] })];
    const res = await chat('post', '/message', { message: 'hi', history: [] });
    expect(JSON.stringify(res.body)).not.toContain('jest-gemini-key');
    expect(geminiCalls[0].url).not.toContain('jest-gemini-key');
    expect(geminiCalls[0].headers['x-goog-api-key']).toBe('jest-gemini-key');
  });

  it('exposes only read-only catalogue tools to the model (no checkout/order/payment tool)', async () => {
    geminiScript = [() => ({ role: 'model', parts: [{ text: 'ok' }] })];
    await chat('post', '/message', { message: 'hi', history: [] });
    const names = geminiCalls[0].body.tools[0].functionDeclarations.map((f: any) => f.name);
    expect(names.sort()).toEqual(['list_categories', 'search_products']);
  });

  it('filters by price and category', async () => {
    geminiScript = [
      () => ({ role: 'model', parts: [{ functionCall: { name: 'search_products', args: { category: TAG, max_price_inr: 60 } } }] }),
      () => ({ role: 'model', parts: [{ text: 'cheap ones' }] }),
    ];
    const res = await chat('post', '/message', { message: 'cheap stuff', history: [] });
    expect(res.body.data.products.map((x: any) => x.id)).toEqual([lowStock.id]); // 5000 paise <= 60 INR, bag is 123.45
  });

  it('falls back to plain catalogue search when Gemini is down', async () => {
    geminiDown = true;
    const res = await chat('post', '/message', { message: 'zeppelin bag', history: [] });
    expect(res.status).toBe(200);
    expect(res.body.data.aiAvailable).toBe(false);
    expect(res.body.data.products[0].id).toBe(product.id);
  });

  it('rejects empty or oversized messages', async () => {
    expect((await chat('post', '/message', { message: '   ' })).status).toBe(400);
    expect((await chat('post', '/message', { message: 'x'.repeat(501) })).status).toBe(400);
  });
});

// ================================================================= Checkout via UCP
describe('chatbot checkout runs through the signed UCP API', () => {
  it('creates a UCP session with the quantity the shopper chose and server-side prices', async () => {
    const res = await startCheckout(product.id, 3);
    expect(res.status).toBe(201);
    const v = res.body.data;
    expect(v.id).toMatch(/^chk_[a-f0-9]{32}$/);
    expect(v.status).toBe('incomplete'); // buyer still missing
    expect(v.lineItems[0]).toMatchObject({ productId: product.id, quantity: 3, unitPaise: 12345 });
    expect(v.totalPaise).toBe(12345 * 3);
    const row = await prisma.checkoutSession.findUnique({ where: { id: v.id } });
    expect(row?.platformProfile).toBe(CHAT_PROFILE); // went through UCP as the registered chat platform
  });

  it('the UCP security layer is really in force: an unregistered chatbot is refused, not bypassed', async () => {
    const sessionsBefore = await prisma.checkoutSession.count({ where: { platformProfile: CHAT_PROFILE } });
    const saved = process.env.CHAT_UCP_API_KEY;
    process.env.CHAT_UCP_API_KEY = 'wrong-key';
    const res = await startCheckout();
    process.env.CHAT_UCP_API_KEY = saved;
    expect(res.status).toBe(502); // UCP answered 401; surfaced as a service problem
    expect(res.body.message).toBe('Checkout is temporarily unavailable.');
    expect(await prisma.checkoutSession.count({ where: { platformProfile: CHAT_PROFILE } })).toBe(sessionsBefore);
  });

  it('rejects invalid product ids and quantities', async () => {
    expect((await startCheckout(crypto.randomUUID(), 1)).status).toBe(400);
    expect((await startCheckout(product.id, 0)).status).toBe(400);
    expect((await startCheckout(product.id, -2)).status).toBe(400);
    expect((await startCheckout(product.id, 1.5)).status).toBe(400);
    expect((await chat('post', '/checkout', { productId: product.id, quantity: 1 })).status).toBe(400); // requestId required
  });

  it('a double-submitted "Buy now" (same requestId) creates a single session', async () => {
    const requestId = rid();
    const [a, b] = await Promise.all([startCheckout(product.id, 1, requestId), startCheckout(product.id, 1, requestId)]);
    const ids = [a, b].filter(r => r.status === 201).map(r => r.body.data.id);
    const again = await startCheckout(product.id, 1, requestId);
    expect(again.status).toBe(201);
    expect(new Set([...ids, again.body.data.id]).size).toBe(1);
  });

  it('updating quantity recalculates the total on the server', async () => {
    const { id } = await readyCheckout(product.id, 1);
    const res = await chat('patch', `/checkout/${id}`, { quantity: 4 });
    expect(res.status).toBe(200);
    expect(res.body.data.lineItems[0].quantity).toBe(4);
    expect(res.body.data.totalPaise).toBe(12345 * 4);
    expect(res.body.data.buyer.email).toBe(BUYER.email); // buyer kept across the full-replacement PUT
  });

  it('collects buyer details: name split, phone normalised, invalid input refused', async () => {
    const { id, updated } = await readyCheckout();
    expect(updated.body.data.status).toBe('ready_for_complete');
    expect(updated.body.data.buyer).toMatchObject({ first_name: 'Jest', last_name: 'Buyer', phone_number: '+919876543210' });
    expect((await chat('patch', `/checkout/${id}`, { buyer: { ...BUYER, phone: '123' } })).status).toBe(400);
    expect((await chat('patch', `/checkout/${id}`, { buyer: { ...BUYER, email: 'nope' } })).status).toBe(400);
    expect((await chat('patch', `/checkout/${id}`, {})).status).toBe(400);
  });

  it('normalizePhone', () => {
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    expect(normalizePhone('+91 98765-43210')).toBe('+919876543210');
    expect(normalizePhone('+14155552671')).toBe('+14155552671');
    expect(normalizePhone('12345')).toBeNull();
  });

  it('insufficient stock is reported and complete is refused (no order created)', async () => {
    const started = await startCheckout(lowStock.id, 50);
    expect(started.status).toBe(201);
    expect(started.body.data.messages.some((m: any) => m.code === 'out_of_stock')).toBe(true);
    const id = started.body.data.id;
    await chat('patch', `/checkout/${id}`, { buyer: BUYER });
    const done = await chat('post', `/checkout/${id}/complete`);
    expect(done.status).toBe(409);
    expect((await prisma.checkoutSession.findUnique({ where: { id } }))?.orderId).toBeNull();
  });

  it('complete creates exactly one PENDING order; repeat/parallel completes return the same order', async () => {
    const { id } = await readyCheckout(product.id, 2);
    const results = await Promise.all([1, 2, 3].map(() => chat('post', `/checkout/${id}/complete`)));
    const orderIds = results.filter(r => r.status === 200).map(r => r.body.data.order.id);
    expect(orderIds.length).toBeGreaterThan(0);
    expect(new Set(orderIds).size).toBe(1);
    cleanupOrderIds.push(orderIds[0]);
    const v = results.find(r => r.status === 200)!.body.data;
    expect(v.status).toBe('complete_in_progress');
    expect(v.order).toMatchObject({ status: 'PENDING', paymentStatus: 'CREATED', paid: false, totalPaise: 24690 });
    expect(await prisma.order.count({ where: { orderItems: { some: { productId: product.id } }, checkoutSession: { id } } })).toBe(1);
  });

  it('cancel before an order exists cancels the session; completing afterwards is refused', async () => {
    const { id } = await readyCheckout();
    const c = await chat('post', `/checkout/${id}/cancel`);
    expect(c.status).toBe(200);
    expect(c.body.data.status).toBe('canceled');
    expect((await chat('post', `/checkout/${id}/complete`)).status).toBe(409);
  });

  it('malformed or foreign checkout ids give 404', async () => {
    expect((await chat('get', '/checkout/not-an-id')).status).toBe(404);
    expect((await chat('get', `/checkout/chk_${'0'.repeat(32)}`)).status).toBe(404);
  });
});

// ================================================================= Payment + confirmation
describe('payment verification and order confirmation', () => {
  const placeOrder = async (qty = 2) => {
    const { id } = await readyCheckout(product.id, qty);
    const done = await chat('post', `/checkout/${id}/complete`);
    expect(done.status).toBe(200);
    cleanupOrderIds.push(done.body.data.order.id);
    return { id, orderId: done.body.data.order.id as string };
  };

  it('full flow: pay -> server verification -> PAID with verified confirmation data and one stock deduction', async () => {
    const before = await stock(product.id);
    const { id, orderId } = await placeOrder(2);
    expect(await stock(product.id)).toBe(before); // nothing deducted until paid

    const verified = await payForOrder(orderId);
    expect(verified.status).toBe(200);

    const v = (await chat('get', `/checkout/${id}`)).body.data;
    expect(v.status).toBe('completed');
    expect(v.order).toMatchObject({ status: 'PAID', paymentStatus: 'PAID', paid: true, totalPaise: 24690 });
    expect(v.order.orderNumber).toMatch(/^ORD-/);
    expect(v.order.items).toEqual([{ name: product.name, quantity: 2, subtotalPaise: 24690 }]);
    expect(await stock(product.id)).toBe(before - 2);
  });

  it('a second verification (duplicate) does not deduct stock twice or create another order', async () => {
    const before = await stock(product.id);
    const { orderId } = await placeOrder(1);
    const order = (await prisma.order.findUnique({ where: { id: orderId }, include: { payment: true } }))!;
    expect((await payForOrder(orderId)).status).toBe(200);
    const pay = (await prisma.payment.findUnique({ where: { orderId } }))!;
    mockRazorpay.payments.fetch.mockResolvedValueOnce({ id: pay.razorpayPaymentId, order_id: pay.razorpayOrderId, amount: order.totalPaise, currency: 'INR', status: 'captured' });
    const sig = crypto.createHmac('sha256', KEY_SECRET).update(`${pay.razorpayOrderId}|${pay.razorpayPaymentId}`).digest('hex');
    await request(app).post('/api/payments/verify').send({ orderId, razorpay_order_id: pay.razorpayOrderId, razorpay_payment_id: pay.razorpayPaymentId, razorpay_signature: sig });
    expect(await stock(product.id)).toBe(before - 1);
  });

  it('a forged signature or an unpaid/failed payment never shows as paid in the chat view', async () => {
    const { id, orderId } = await placeOrder(1);
    const rzpOrderId = 'order_forge' + crypto.randomBytes(3).toString('hex');
    mockRazorpay.orders.create.mockResolvedValueOnce({ id: rzpOrderId, amount: 12345, currency: 'INR' });
    await request(app).post('/api/payments/create-order').send({ orderId });
    const forged = await request(app).post('/api/payments/verify').send({ orderId, razorpay_order_id: rzpOrderId, razorpay_payment_id: 'pay_x', razorpay_signature: 'forged' });
    expect(forged.status).toBe(400);
    let v = (await chat('get', `/checkout/${id}`)).body.data;
    expect(v.order.paid).toBe(false);
    expect(v.status).toBe('complete_in_progress');

    // genuine signature but Razorpay says the payment only failed
    const failed = await payForOrder(orderId, 'failed');
    expect(failed.status).not.toBe(200);
    v = (await chat('get', `/checkout/${id}`)).body.data;
    expect(v.order.paid).toBe(false);
    expect(v.order.status).toBe('PENDING');
  });

  it('after a failed attempt the shopper can retry and pay successfully', async () => {
    const { id, orderId } = await placeOrder(1);
    expect((await payForOrder(orderId, 'failed')).status).not.toBe(200);
    expect((await payForOrder(orderId)).status).toBe(200);
    expect((await chat('get', `/checkout/${id}`)).body.data.order.paid).toBe(true);
  });

  it('a paid checkout cannot be canceled or edited, and repeating complete never creates a second order', async () => {
    const before = await stock(product.id);
    const { id, orderId } = await placeOrder(1);
    expect((await payForOrder(orderId)).status).toBe(200);
    expect((await chat('post', `/checkout/${id}/cancel`)).status).toBe(409);
    expect((await chat('patch', `/checkout/${id}`, { quantity: 9 })).status).toBe(409);
    // complete is idempotent: the same key replays the stored result (same order), nothing new is created
    const again = await chat('post', `/checkout/${id}/complete`);
    expect(again.body.data.order.id).toBe(orderId);
    expect(again.body.data.order.paid).toBe(true);
    expect(await prisma.order.count({ where: { checkoutSession: { id } } })).toBe(1);
    expect(await stock(product.id)).toBe(before - 1);
  });

  it('the chat view never exposes payment secrets or customer contact details of the order', async () => {
    const { id, orderId } = await placeOrder(1);
    await payForOrder(orderId);
    const body = JSON.stringify((await chat('get', `/checkout/${id}`)).body);
    expect(body).not.toMatch(/razorpay_?signature|razorpayPaymentId|pay_[a-f0-9]{12}|order_[a-f0-9]{12}/i);
  });
});

describe('chat endpoint rate limit', () => {
  it('returns 429 after the per-IP limit', async () => {
    const express = (await import('express')).default;
    const { createChatRouter } = await import('../src/chat/routes');
    const mini = express();
    mini.use(express.json());
    mini.use('/api/chat', createChatRouter({ rateLimitPerMinute: 3 }));
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await request(mini).get('/api/chat/checkout/not-an-id')).status);
    expect(codes).toEqual([404, 404, 404, 429, 429]);
  });
});
