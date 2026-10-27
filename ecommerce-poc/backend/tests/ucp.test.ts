/**
 * UCP integration tests. They run against the real MySQL database (own rows only, removed in
 * afterAll) with Razorpay mocked, because the behaviour under test (conditional transitions,
 * unique constraints, atomic stock updates) only exists in the database.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { exportJWK, FlattenedSign, generateKeyPair, importJWK } from 'jose';

const PROFILE = 'https://jest.local.test/profile';
const API_KEY = `ucp_jest_${crypto.randomBytes(8).toString('hex')}`;
const WEBHOOK_SECRET = 'jest_webhook_secret';
const KEY_SECRET = 'jest_key_secret';
const TAG = `ucp-jest-${Date.now()}`;

process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.RAZORPAY_KEY_ID = 'rzp_test_jest';

const mockRazorpay = {
  orders: { create: jest.fn() },
  payments: { fetch: jest.fn() },
};
jest.mock('../src/utils/razorpay', () => ({ razorpay: mockRazorpay }));

import app from '../src/app';
import prisma from '../src/utils/prisma';
import { createUcpRouter } from '../src/ucp/routes';

// ---------------------------------------------------------------- schema validation
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const loadSchemas = (dir: string) => {
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) loadSchemas(full);
    else if (f.endsWith('.json')) {
      const schema = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (schema.$id && !ajv.getSchema(schema.$id)) ajv.addSchema(schema);
    }
  }
};
const schemaRoot = path.resolve(__dirname, '..', 'ucp-schemas');
loadSchemas(path.join(schemaRoot, 'schemas'));
// profile_schema.json uses refs relative to the repo's source/ layout ("../schemas/ucp.json");
// resolve them to the published $id URLs. Content is otherwise untouched.
const profileSchema = JSON.parse(
  fs.readFileSync(path.join(schemaRoot, 'discovery', 'profile_schema.json'), 'utf8').split('"../schemas/').join('"https://ucp.dev/schemas/')
);
ajv.addSchema(profileSchema);
const validateCheckout = ajv.getSchema('https://ucp.dev/schemas/shopping/checkout.json')!;
// The top-level oneOf (platform | business) is ambiguous for a business profile, which also
// satisfies the platform variant, so validate against the business variant directly.
const validateProfile = ajv.getSchema('https://ucp.dev/schemas/discovery/profile.json#/$defs/business_profile')!;
const expectValidCheckout = (body: any) => {
  const ok = validateCheckout(body);
  if (!ok) throw new Error('Checkout violates official schema: ' + JSON.stringify(validateCheckout.errors, null, 2));
};

// ---------------------------------------------------------------- signing client
let signingKey: any;
let otherKey: any;
let kid = 'jest-key';

const sign = async (payload: string, key = signingKey) =>
  {
    const jws = await new FlattenedSign(Buffer.from(payload, 'utf8'))
      .setProtectedHeader({ alg: 'ES256', kid, b64: false, crit: ['b64'] })
      .sign(key);
    return `${jws.protected}..${jws.signature}`;
  };

interface CallOpts {
  headers?: Record<string, string | undefined>;
  idemKey?: string;
  signPayload?: string;
  noSign?: boolean;
  signKey?: any;
}

const api = async (method: 'get' | 'post' | 'put', urlPath: string, body?: unknown, o: CallOpts = {}) => {
  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string | undefined> = {
    'UCP-Agent': `profile="${PROFILE}"`,
    'Request-Id': crypto.randomUUID(),
    'X-API-Key': API_KEY,
  };
  if (method !== 'get') headers['Idempotency-Key'] = o.idemKey ?? crypto.randomUUID();
  if (bodyStr) headers['Content-Type'] = 'application/json';
  if (!o.noSign) headers['Request-Signature'] = await sign(o.signPayload ?? bodyStr, o.signKey);
  Object.assign(headers, o.headers);

  let req = request(app)[method](`/ucp/v1${urlPath}`);
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) req = req.set(k, v);
  return bodyStr ? req.send(bodyStr) : req;
};

const BUYER = { first_name: 'Jest', last_name: 'Buyer', email: 'jest.buyer@example.com', phone_number: '+919876543210' };

// ---------------------------------------------------------------- fixtures
let categoryId: string;
let product: { id: string; pricePaise: number };
let soldOut: { id: string };
const orderIds: string[] = [];

const createProduct = (suffix: string, stock: number, pricePaise = 10000) =>
  prisma.product.create({
    data: {
      name: `UCP Jest ${suffix}`,
      slug: `${TAG}-${suffix}`,
      description: 'created by ucp.test.ts',
      pricePaise,
      images: [],
      stock,
      categoryId,
    },
  });

const newCheckout = async (productId = product.id, quantity = 1, buyer: object | null = BUYER) => {
  const res = await api('post', '/checkout-sessions', { line_items: [{ item: { id: productId }, quantity }], ...(buyer ? { buyer } : {}) });
  expect(res.status).toBe(201);
  return res.body as any;
};

const completeCheckout = async (id: string) => {
  const res = await api('post', `/checkout-sessions/${id}/complete`, {});
  if (res.body.order?.id) orderIds.push(res.body.order.id);
  return res;
};

const getStock = async (id: string) => (await prisma.product.findUnique({ where: { id } }))!.stock;

/** Simulates what the Razorpay Checkout page does after the buyer pays. */
const attemptPayment = async (orderId: string, rzpOrderId = `order_${crypto.randomBytes(6).toString('hex')}`) => {
  const order = (await prisma.order.findUnique({ where: { id: orderId } }))!;
  mockRazorpay.orders.create.mockResolvedValueOnce({ id: rzpOrderId, amount: order.totalPaise, currency: 'INR' });
  const created = await request(app).post('/api/payments/create-order').send({ orderId });
  expect(created.status).toBe(200);
  expect(mockRazorpay.orders.create).toHaveBeenLastCalledWith(expect.objectContaining({ amount: order.totalPaise }));
  return { rzpOrderId, rzpPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`, amount: order.totalPaise };
};

const verifyBody = (orderId: string, p: { rzpOrderId: string; rzpPaymentId: string }, signature?: string) => ({
  orderId,
  razorpay_order_id: p.rzpOrderId,
  razorpay_payment_id: p.rzpPaymentId,
  razorpay_signature:
    signature ?? crypto.createHmac('sha256', KEY_SECRET).update(`${p.rzpOrderId}|${p.rzpPaymentId}`).digest('hex'),
});

const rzpPaymentStatus = (p: { rzpOrderId: string; rzpPaymentId: string; amount: number }, status: string) =>
  mockRazorpay.payments.fetch.mockResolvedValueOnce({
    id: p.rzpPaymentId,
    order_id: p.rzpOrderId,
    amount: p.amount,
    currency: 'INR',
    status,
  });

// ---------------------------------------------------------------- lifecycle
beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const other = await generateKeyPair('ES256', { extractable: true });
  signingKey = pair.privateKey;
  otherKey = other.privateKey;
  const pub = { ...(await exportJWK(pair.publicKey)), kid, alg: 'ES256', use: 'sig' };
  process.env.UCP_PLATFORMS_JSON = JSON.stringify({
    platforms: [
      {
        name: 'ucp-jest',
        profile: PROFILE,
        api_key_sha256: crypto.createHash('sha256').update(API_KEY).digest('hex'),
        signing_keys: [pub],
      },
    ],
  });
  await importJWK(pub as any, 'ES256');

  const cat = await prisma.category.create({ data: { name: TAG, slug: TAG } });
  categoryId = cat.id;
  product = await createProduct('main', 1000, 10000);
  soldOut = await createProduct('soldout', 0, 5000);
});

afterAll(async () => {
  const sessions = await prisma.checkoutSession.findMany({ where: { platformProfile: PROFILE } });
  const allOrderIds = [...new Set([...orderIds, ...sessions.map(s => s.orderId).filter(Boolean)])] as string[];
  const productIds = (await prisma.product.findMany({ where: { categoryId }, select: { id: true } })).map(p => p.id);
  const itemOrders = await prisma.orderItem.findMany({ where: { productId: { in: productIds } }, select: { orderId: true } });
  const ids = [...new Set([...allOrderIds, ...itemOrders.map(i => i.orderId)])];

  await prisma.checkoutSession.deleteMany({ where: { platformProfile: PROFILE } });
  await prisma.payment.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.order.deleteMany({ where: { id: { in: ids } } });
  await prisma.idempotencyRecord.deleteMany({ where: { scope: { startsWith: 'ucp-jest|' } } });
  await prisma.product.deleteMany({ where: { categoryId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.$disconnect();
});

beforeEach(() => {
  mockRazorpay.orders.create.mockReset();
  mockRazorpay.payments.fetch.mockReset();
});

// ================================================================= Test A
describe('A. discovery', () => {
  it('serves a profile that validates against the official profile schema', async () => {
    const res = await request(app).get('/.well-known/ucp');
    expect(res.status).toBe(200);
    const ok = validateProfile(res.body);
    if (!ok) throw new Error(JSON.stringify(validateProfile.errors, null, 2));
  });

  it('advertises only what is implemented', async () => {
    const { ucp } = (await request(app).get('/.well-known/ucp')).body;
    expect(ucp.version).toBe('2026-01-11');
    expect(Object.keys(ucp.capabilities)).toEqual(['dev.ucp.shopping.checkout']);
    expect(ucp.services['dev.ucp.shopping']).toHaveLength(1);
    expect(ucp.services['dev.ucp.shopping'][0]).toMatchObject({ transport: 'rest' });
    expect(ucp.services['dev.ucp.shopping'][0].endpoint).toMatch(/\/ucp\/v1$/);
    expect(ucp.payment_handlers).toEqual({});
  });
});

// ================================================================= Test M
describe('M. required headers, authentication and signatures', () => {
  const body = () => ({ line_items: [{ item: { id: product.id }, quantity: 1 }] });

  it('rejects a missing or malformed Request-Id (400)', async () => {
    expect((await api('post', '/checkout-sessions', body(), { headers: { 'Request-Id': undefined } })).status).toBe(400);
    expect((await api('post', '/checkout-sessions', body(), { headers: { 'Request-Id': 'nope' } })).status).toBe(400);
  });

  it('rejects a missing or malformed UCP-Agent (400)', async () => {
    expect((await api('post', '/checkout-sessions', body(), { headers: { 'UCP-Agent': undefined } })).status).toBe(400);
    expect((await api('post', '/checkout-sessions', body(), { headers: { 'UCP-Agent': 'garbage' } })).status).toBe(400);
  });

  it('rejects a missing or malformed Idempotency-Key on mutating calls (400)', async () => {
    expect((await api('post', '/checkout-sessions', body(), { headers: { 'Idempotency-Key': undefined } })).status).toBe(400);
    expect((await api('post', '/checkout-sessions', body(), { headers: { 'Idempotency-Key': 'abc' } })).status).toBe(400);
  });

  it('rejects an unregistered platform (403)', async () => {
    const res = await api('post', '/checkout-sessions', body(), { headers: { 'UCP-Agent': 'profile="https://evil.test/p"' } });
    expect(res.status).toBe(403);
  });

  it('rejects a missing or wrong API key (401)', async () => {
    expect((await api('post', '/checkout-sessions', body(), { headers: { 'X-API-Key': undefined } })).status).toBe(401);
    expect((await api('post', '/checkout-sessions', body(), { headers: { 'X-API-Key': 'wrong' } })).status).toBe(401);
  });

  it('rejects a missing signature (401)', async () => {
    const res = await api('post', '/checkout-sessions', body(), { noSign: true });
    expect(res.status).toBe(401);
    expect(res.body.messages[0].code).toBe('signature_required');
  });

  it('rejects a signature over a different body (tampering) (401)', async () => {
    const res = await api('post', '/checkout-sessions', body(), { signPayload: '{"line_items":[]}' });
    expect(res.status).toBe(401);
    expect(res.body.messages[0].code).toBe('invalid_signature');
  });

  it('rejects a signature made with an unregistered private key (401)', async () => {
    const res = await api('post', '/checkout-sessions', body(), { signKey: otherKey });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed signature header (401)', async () => {
    const res = await api('post', '/checkout-sessions', body(), { headers: { 'Request-Signature': 'a.b.c' } });
    expect(res.status).toBe(401);
  });

  it('returns structured UCP errors without leaking internals', async () => {
    const res = await api('post', '/checkout-sessions', body(), { noSign: true });
    expect(res.body.messages[0]).toMatchObject({ type: 'error', severity: 'recoverable' });
    expect(JSON.stringify(res.body)).not.toMatch(/stack|prisma|at Object/i);
  });

  it('rate limits (429)', async () => {
    const limited = express();
    limited.use('/ucp/v1', createUcpRouter({ rateLimitPerMinute: 3 }));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await request(limited).get('/ucp/v1/checkout-sessions/x')).status);
    expect(statuses.slice(0, 3)).toEqual([400, 400, 400]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });
});

// ================================================================= Tests C, D, G
describe('C/D/G. create, retrieve, price tampering', () => {
  it('creates a schema-valid checkout with server-side prices', async () => {
    const body = await newCheckout(product.id, 2, null);
    expectValidCheckout(body);
    expect(body.status).toBe('incomplete');
    expect(body.currency).toBe('INR');
    expect(body.line_items[0].item).toMatchObject({ id: product.id, price: 10000 });
    expect(body.totals).toEqual([
      { type: 'subtotal', amount: 20000 },
      { type: 'total', amount: 20000 },
    ]);
    expect(body.messages.map((m: any) => m.path)).toEqual(
      expect.arrayContaining(['$.buyer.email', '$.buyer.phone_number', '$.buyer.first_name'])
    );
  });

  it('is ready_for_complete once the buyer is supplied', async () => {
    const body = await newCheckout(product.id, 1, BUYER);
    expectValidCheckout(body);
    expect(body.status).toBe('ready_for_complete');
    expect(body.messages).toBeUndefined();
  });

  it('G. ignores client-supplied price/title/currency', async () => {
    const res = await api('post', '/checkout-sessions', {
      currency: 'USD',
      line_items: [{ item: { id: product.id, price: 1, title: 'Free stuff' }, quantity: 3 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.currency).toBe('INR');
    expect(res.body.line_items[0].item).toMatchObject({ price: 10000 });
    expect(res.body.line_items[0].item.title).toBe('UCP Jest main');
    expect(res.body.totals[1].amount).toBe(30000);
  });

  it('D. retrieves the session with identical content', async () => {
    const created = await newCheckout();
    const res = await api('get', `/checkout-sessions/${created.id}`);
    expect(res.status).toBe(200);
    expectValidCheckout(res.body);
    expect(res.body).toEqual(created);
  });

  it('returns 404 for an unknown session', async () => {
    const res = await api('get', '/checkout-sessions/chk_doesnotexist');
    expect(res.status).toBe(404);
  });
});

// ================================================================= Test F
describe('F. invalid input', () => {
  const post = (line_items: unknown) => api('post', '/checkout-sessions', { line_items });

  it('rejects an unknown product id (400)', async () => {
    const res = await post([{ item: { id: crypto.randomUUID() }, quantity: 1 }]);
    expect(res.status).toBe(400);
    expect(res.body.messages[0]).toMatchObject({ type: 'error', code: 'invalid', path: '$.line_items[0].item.id' });
  });

  it('rejects a non-positive, fractional or string quantity (400)', async () => {
    for (const quantity of [0, -1, 1.5, '2']) {
      const res = await post([{ item: { id: product.id }, quantity }]);
      expect(res.status).toBe(400);
    }
  });

  it('rejects an absurd quantity (400)', async () => {
    expect((await post([{ item: { id: product.id }, quantity: 1000000 }])).status).toBe(400);
  });

  it('rejects empty or missing line_items (400)', async () => {
    expect((await post([])).status).toBe(400);
    expect((await api('post', '/checkout-sessions', {})).status).toBe(400);
  });

  it('rejects an invalid buyer email / phone (400)', async () => {
    const res = await api('post', '/checkout-sessions', {
      line_items: [{ item: { id: product.id }, quantity: 1 }],
      buyer: { email: 'not-an-email', phone_number: '12345' },
    });
    expect(res.status).toBe(400);
    expect(res.body.messages.map((m: any) => m.path)).toEqual(expect.arrayContaining(['$.buyer.email', '$.buyer.phone_number']));
  });

  it('rejects non-JSON bodies (400)', async () => {
    const res = await request(app)
      .post('/ucp/v1/checkout-sessions')
      .set({
        'UCP-Agent': `profile="${PROFILE}"`,
        'Request-Id': crypto.randomUUID(),
        'Idempotency-Key': crypto.randomUUID(),
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json',
        'Request-Signature': await sign('{broken'),
      })
      .send('{broken');
    expect(res.status).toBe(400);
    expect(res.body.messages[0].code).toBe('invalid_json');
  });

  it('reports insufficient stock on create and refuses to complete (409)', async () => {
    const low = await createProduct('low-stock', 2);
    const body = await newCheckout(low.id, 3, BUYER);
    expect(body.status).toBe('incomplete');
    expect(body.messages[0]).toMatchObject({ code: 'out_of_stock', path: '$.line_items[0].quantity' });
    const res = await completeCheckout(body.id);
    expect(res.status).toBe(409);
    expect(res.body.order).toBeUndefined();
  });

  it('treats a zero-stock product as out of stock', async () => {
    const body = await newCheckout(soldOut.id, 1, BUYER);
    expect(body.messages[0].code).toBe('out_of_stock');
  });
});

// ================================================================= Test E
describe('E. update', () => {
  it('recalculates totals on the server when the quantity changes', async () => {
    const created = await newCheckout(product.id, 1, BUYER);
    const res = await api('put', `/checkout-sessions/${created.id}`, {
      id: created.id,
      buyer: BUYER,
      line_items: [{ id: created.line_items[0].id, item: { id: product.id, price: 1 }, quantity: 4 }],
    });
    expect(res.status).toBe(200);
    expectValidCheckout(res.body);
    expect(res.body.line_items[0].quantity).toBe(4);
    expect(res.body.totals).toEqual([
      { type: 'subtotal', amount: 40000 },
      { type: 'total', amount: 40000 },
    ]);
  });

  it('moves incomplete -> ready_for_complete when the buyer is added', async () => {
    const created = await newCheckout(product.id, 1, null);
    expect(created.status).toBe('incomplete');
    const res = await api('put', `/checkout-sessions/${created.id}`, {
      buyer: BUYER,
      line_items: [{ item: { id: product.id }, quantity: 1 }],
    });
    expect(res.body.status).toBe('ready_for_complete');
  });

  it('is a full replacement (omitting buyer clears it)', async () => {
    const created = await newCheckout(product.id, 1, BUYER);
    const res = await api('put', `/checkout-sessions/${created.id}`, { line_items: [{ item: { id: product.id }, quantity: 1 }] });
    expect(res.body.buyer).toBeUndefined();
    expect(res.body.status).toBe('incomplete');
  });

  it('rejects updating to an invalid product (400) and a mismatched body id (400)', async () => {
    const created = await newCheckout();
    const bad = await api('put', `/checkout-sessions/${created.id}`, { line_items: [{ item: { id: crypto.randomUUID() }, quantity: 1 }] });
    expect(bad.status).toBe(400);
    const mismatch = await api('put', `/checkout-sessions/${created.id}`, { id: 'chk_other', line_items: [{ item: { id: product.id }, quantity: 1 }] });
    expect(mismatch.status).toBe(400);
  });
});

// ================================================================= Tests H, I
describe('H/I. complete + Razorpay payment + order confirmation', () => {
  it('creates exactly one PENDING order at complete, priced from the database', async () => {
    const created = await newCheckout(product.id, 3, BUYER);
    const res = await completeCheckout(created.id);
    expect(res.status).toBe(200);
    expectValidCheckout(res.body);
    expect(res.body.status).toBe('complete_in_progress');
    expect(res.body.continue_url).toMatch(/\/payment\/[0-9a-f-]{36}$/);
    expect(res.body.order.id).toBeDefined();

    const order = await prisma.order.findUnique({ where: { id: res.body.order.id }, include: { orderItems: true, payment: true } });
    expect(order).toMatchObject({ status: 'PENDING', totalPaise: 30000, customerEmail: BUYER.email });
    expect(order!.orderItems).toHaveLength(1);
    expect(order!.orderItems[0]).toMatchObject({ pricePaise: 10000, quantity: 3 });
    expect(order!.payment).toMatchObject({ status: 'CREATED', amountPaise: 30000 });
    expect(await getStock(product.id)).toBe(1000); // not decremented before payment
  });

  it('never creates a second order when complete is repeated or raced', async () => {
    const created = await newCheckout(product.id, 1, BUYER);
    const results = await Promise.all([completeCheckout(created.id), completeCheckout(created.id), completeCheckout(created.id)]);
    results.forEach(r => expect([200]).toContain(r.status));
    expect(new Set(results.map(r => r.body.order?.id)).size).toBe(1);
    expect(await prisma.checkoutSession.count({ where: { id: created.id, orderId: { not: null } } })).toBe(1);
    const orders = await prisma.order.count({ where: { id: results[0].body.order.id } });
    expect(orders).toBe(1);
  });

  it('full happy path: pay -> verify -> checkout completed, stock decremented once', async () => {
    const before = await getStock(product.id);
    const created = await newCheckout(product.id, 2, BUYER);
    const done = await completeCheckout(created.id);
    const orderId = done.body.order.id;

    const pay = await attemptPayment(orderId);
    rzpPaymentStatus(pay, 'captured');
    const verify = await request(app).post('/api/payments/verify').send(verifyBody(orderId, pay));
    expect(verify.status).toBe(200);
    expect(verify.body.data.status).toBe('PAID');
    expect(verify.body.alreadyPaid).toBe(false);

    const got = await api('get', `/checkout-sessions/${created.id}`);
    expectValidCheckout(got.body);
    expect(got.body.status).toBe('completed');
    expect(got.body.continue_url).toBeUndefined();
    expect(got.body.order.id).toBe(orderId);
    expect(await getStock(product.id)).toBe(before - 2);

    const payment = await prisma.payment.findUnique({ where: { orderId } });
    expect(payment).toMatchObject({ status: 'PAID', razorpayOrderId: pay.rzpOrderId, razorpayPaymentId: pay.rzpPaymentId });

    // duplicate callback: no second decrement
    rzpPaymentStatus(pay, 'captured');
    const again = await request(app).post('/api/payments/verify').send(verifyBody(orderId, pay));
    expect(again.status).toBe(200);
    expect(again.body.alreadyPaid).toBe(true);
    expect(await getStock(product.id)).toBe(before - 2);

    // a completed checkout is immutable
    expect((await completeCheckout(created.id)).status).toBe(409);
    expect((await api('post', `/checkout-sessions/${created.id}/cancel`)).status).toBe(409);
    const upd = await api('put', `/checkout-sessions/${created.id}`, { line_items: [{ item: { id: product.id }, quantity: 1 }] });
    expect(upd.status).toBe(409);
  });
});

// ================================================================= Test J
describe('J. failed payment and invalid verification', () => {
  const pendingOrder = async () => {
    const created = await newCheckout(product.id, 1, BUYER);
    const done = await completeCheckout(created.id);
    return { sessionId: created.id, orderId: done.body.order.id as string };
  };
  const expectUnpaid = async (sessionId: string, orderId: string) => {
    expect((await prisma.order.findUnique({ where: { id: orderId } }))!.status).toBe('PENDING');
    expect((await api('get', `/checkout-sessions/${sessionId}`)).body.status).toBe('complete_in_progress');
  };

  it('a forged signature is rejected and changes nothing', async () => {
    const { sessionId, orderId } = await pendingOrder();
    const pay = await attemptPayment(orderId);
    const res = await request(app).post('/api/payments/verify').send(verifyBody(orderId, pay, 'deadbeef'));
    expect(res.status).toBe(400);
    expect(mockRazorpay.payments.fetch).not.toHaveBeenCalled();
    await expectUnpaid(sessionId, orderId);
  });

  it('a valid signature for another order\'s Razorpay order is rejected', async () => {
    const { sessionId, orderId } = await pendingOrder();
    await attemptPayment(orderId);
    const foreign = { rzpOrderId: 'order_foreign', rzpPaymentId: 'pay_foreign' };
    const res = await request(app).post('/api/payments/verify').send(verifyBody(orderId, foreign));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not belong/);
    await expectUnpaid(sessionId, orderId);
  });

  it('a payment for a different amount is rejected', async () => {
    const { sessionId, orderId } = await pendingOrder();
    const pay = await attemptPayment(orderId);
    rzpPaymentStatus({ ...pay, amount: 100 }, 'captured');
    const res = await request(app).post('/api/payments/verify').send(verifyBody(orderId, pay));
    expect(res.status).toBe(400);
    await expectUnpaid(sessionId, orderId);
  });

  it('a failed Razorpay payment is not marked paid', async () => {
    const { sessionId, orderId } = await pendingOrder();
    const pay = await attemptPayment(orderId);
    rzpPaymentStatus(pay, 'failed');
    const res = await request(app).post('/api/payments/verify').send(verifyBody(orderId, pay));
    expect(res.status).toBe(400);
    expect((await prisma.payment.findUnique({ where: { orderId } }))!.status).toBe('FAILED');
    await expectUnpaid(sessionId, orderId);
  });

  it('an authorized-but-not-captured payment stays pending', async () => {
    const { sessionId, orderId } = await pendingOrder();
    const pay = await attemptPayment(orderId);
    rzpPaymentStatus(pay, 'authorized');
    const res = await request(app).post('/api/payments/verify').send(verifyBody(orderId, pay));
    expect(res.status).toBe(409);
    await expectUnpaid(sessionId, orderId);
  });

  it('a failed attempt can be retried successfully', async () => {
    const { sessionId, orderId } = await pendingOrder();
    const pay = await attemptPayment(orderId);
    rzpPaymentStatus(pay, 'failed');
    await request(app).post('/api/payments/verify').send(verifyBody(orderId, pay));
    const retry = { ...pay, rzpPaymentId: 'pay_retry_ok' };
    rzpPaymentStatus(retry, 'captured');
    const res = await request(app).post('/api/payments/verify').send(verifyBody(orderId, retry));
    expect(res.status).toBe(200);
    expect((await api('get', `/checkout-sessions/${sessionId}`)).body.status).toBe('completed');
  });

  it('Razorpay being unreachable does not mark the order paid (502)', async () => {
    const { sessionId, orderId } = await pendingOrder();
    const pay = await attemptPayment(orderId);
    mockRazorpay.payments.fetch.mockRejectedValueOnce(new Error('network'));
    const res = await request(app).post('/api/payments/verify').send(verifyBody(orderId, pay));
    expect(res.status).toBe(502);
    await expectUnpaid(sessionId, orderId);
  });
});

// ================================================================= webhooks
describe('Razorpay webhook', () => {
  const send = (event: object, signature?: string | null) => {
    const raw = JSON.stringify(event);
    const sig = signature === undefined ? crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') : signature;
    let req = request(app).post('/api/payments/webhook').set('Content-Type', 'application/json');
    if (sig !== null) req = req.set('X-Razorpay-Signature', sig);
    return req.send(raw);
  };
  const capturedEvent = (p: { rzpOrderId: string; rzpPaymentId: string; amount: number }) => ({
    event: 'payment.captured',
    payload: { payment: { entity: { id: p.rzpPaymentId, order_id: p.rzpOrderId, amount: p.amount, status: 'captured' } } },
  });

  it('rejects unsigned and wrongly signed events and does not mark anything paid', async () => {
    const created = await newCheckout(product.id, 1, BUYER);
    const orderId = (await completeCheckout(created.id)).body.order.id;
    const pay = await attemptPayment(orderId);
    expect((await send(capturedEvent(pay), null)).status).toBe(400);
    expect((await send(capturedEvent(pay), 'bad')).status).toBe(400);
    expect((await prisma.order.findUnique({ where: { id: orderId } }))!.status).toBe('PENDING');
  });

  it('marks the order paid once even when the event is delivered repeatedly', async () => {
    const before = await getStock(product.id);
    const created = await newCheckout(product.id, 2, BUYER);
    const orderId = (await completeCheckout(created.id)).body.order.id;
    const pay = await attemptPayment(orderId);
    const event = capturedEvent(pay);

    const results = await Promise.all([send(event), send(event), send(event)]);
    results.forEach(r => expect(r.status).toBe(200));
    expect((await prisma.order.findUnique({ where: { id: orderId } }))!.status).toBe('PAID');
    expect(await getStock(product.id)).toBe(before - 2);
    expect((await api('get', `/checkout-sessions/${created.id}`)).body.status).toBe('completed');
  });

  it('ignores an event whose amount does not match the order', async () => {
    const created = await newCheckout(product.id, 1, BUYER);
    const orderId = (await completeCheckout(created.id)).body.order.id;
    const pay = await attemptPayment(orderId);
    expect((await send(capturedEvent({ ...pay, amount: 1 }))).status).toBe(200);
    expect((await prisma.order.findUnique({ where: { id: orderId } }))!.status).toBe('PENDING');
  });
});

// ================================================================= Test K
describe('K. cancel', () => {
  it('cancels an incomplete/ready session and is repeatable', async () => {
    const created = await newCheckout();
    const res = await api('post', `/checkout-sessions/${created.id}/cancel`);
    expect(res.status).toBe(200);
    expectValidCheckout(res.body);
    expect(res.body.status).toBe('canceled');
    expect(res.body.continue_url).toBeUndefined();
    const again = await api('post', `/checkout-sessions/${created.id}/cancel`);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('canceled');
  });

  it('a canceled session cannot be updated or completed (409)', async () => {
    const created = await newCheckout();
    await api('post', `/checkout-sessions/${created.id}/cancel`);
    const upd = await api('put', `/checkout-sessions/${created.id}`, { line_items: [{ item: { id: product.id }, quantity: 1 }] });
    expect(upd.status).toBe(409);
    expect((await completeCheckout(created.id)).status).toBe(409);
  });

  it('cancels a pending-payment session and its order if payment was not started', async () => {
    const created = await newCheckout();
    const orderId = (await completeCheckout(created.id)).body.order.id;
    const res = await api('post', `/checkout-sessions/${created.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('canceled');
    expect((await prisma.order.findUnique({ where: { id: orderId } }))!.status).toBe('CANCELLED');
  });

  it('refuses to cancel once Razorpay payment has been initiated (409)', async () => {
    const created = await newCheckout();
    const orderId = (await completeCheckout(created.id)).body.order.id;
    await attemptPayment(orderId);
    const res = await api('post', `/checkout-sessions/${created.id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.messages[0].code).toBe('cancel_not_allowed');
    expect((await prisma.order.findUnique({ where: { id: orderId } }))!.status).toBe('PENDING');
  });
});

// ================================================================= Test L
describe('L. idempotency', () => {
  const payload = () => ({ line_items: [{ item: { id: product.id }, quantity: 1 }], buyer: BUYER });

  it('replays the stored response for the same key and body, creating one session', async () => {
    const key = crypto.randomUUID();
    const first = await api('post', '/checkout-sessions', payload(), { idemKey: key });
    const second = await api('post', '/checkout-sessions', payload(), { idemKey: key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const sessions = await prisma.checkoutSession.count({ where: { id: first.body.id } });
    expect(sessions).toBe(1);
  });

  it('returns 409 when a key is reused with a different body', async () => {
    const key = crypto.randomUUID();
    await api('post', '/checkout-sessions', payload(), { idemKey: key });
    const res = await api('post', '/checkout-sessions', { ...payload(), line_items: [{ item: { id: product.id }, quantity: 2 }] }, { idemKey: key });
    expect(res.status).toBe(409);
    expect(res.body.messages[0].code).toBe('idempotency_key_reuse');
  });

  it('replays complete: one order, same response', async () => {
    const created = await newCheckout(product.id, 1, BUYER);
    const key = crypto.randomUUID();
    const a = await api('post', `/checkout-sessions/${created.id}/complete`, {}, { idemKey: key });
    const b = await api('post', `/checkout-sessions/${created.id}/complete`, {}, { idemKey: key });
    orderIds.push(a.body.order.id);
    expect(b.body).toEqual(a.body);
    expect(b.headers['idempotent-replayed']).toBe('true');
  });

  it('scopes keys per path: the same key on another session is not a replay', async () => {
    const key = crypto.randomUUID();
    const a = await newCheckout();
    const b = await newCheckout();
    const r1 = await api('post', `/checkout-sessions/${a.id}/cancel`, undefined, { idemKey: key });
    const r2 = await api('post', `/checkout-sessions/${b.id}/cancel`, undefined, { idemKey: key });
    expect(r1.body.id).toBe(a.id);
    expect(r2.body.id).toBe(b.id);
  });
});

// ================================================================= expiry / ownership / stock race
describe('expiry, ownership and stock races', () => {
  it('an expired session reports canceled and cannot be completed', async () => {
    const created = await newCheckout();
    await prisma.checkoutSession.update({ where: { id: created.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const got = await api('get', `/checkout-sessions/${created.id}`);
    expect(got.body.status).toBe('canceled');
    expect(got.body.messages[0].code).toBe('expired');
    expect((await completeCheckout(created.id)).status).toBe(409);
  });

  it('another platform cannot read a session (404)', async () => {
    const created = await newCheckout();
    await prisma.checkoutSession.update({ where: { id: created.id }, data: { platformProfile: 'https://someone-else.test/p' } });
    expect((await api('get', `/checkout-sessions/${created.id}`)).status).toBe(404);
    await prisma.checkoutSession.update({ where: { id: created.id }, data: { platformProfile: PROFILE } });
  });

  it('two buyers racing for the last unit: stock never goes negative, one payment is refused', async () => {
    const last = await createProduct('last-unit', 1);
    const s1 = await newCheckout(last.id, 1, BUYER);
    const s2 = await newCheckout(last.id, 1, BUYER);
    const o1 = (await completeCheckout(s1.id)).body.order.id;
    const o2 = (await completeCheckout(s2.id)).body.order.id;

    const p1 = await attemptPayment(o1);
    const p2 = await attemptPayment(o2);
    rzpPaymentStatus(p1, 'captured');
    rzpPaymentStatus(p2, 'captured');
    const [r1, r2] = await Promise.all([
      request(app).post('/api/payments/verify').send(verifyBody(o1, p1)),
      request(app).post('/api/payments/verify').send(verifyBody(o2, p2)),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 400]);
    expect(await getStock(last.id)).toBe(0);
    const paid = await prisma.order.count({ where: { id: { in: [o1, o2] }, status: 'PAID' } });
    expect(paid).toBe(1);
  });
});
