/**
 * Live UCP demonstration against a running backend (npm run dev) and the real database.
 *
 *   npm run ucp:setup          # once, registers the test platform + keys
 *   npm run ucp:demo           # Tests A-G, J(verify), K, L, M. Creates only checkout sessions.
 *   npm run ucp:demo -- --pay  # also Tests H/I: completes a checkout (creates a real PENDING
 *                              # order), prints the Razorpay payment link and waits for you to
 *                              # pay with a Razorpay TEST card, then confirms the order is PAID.
 */
import crypto from 'crypto';
import { BASE_URL, call, signDetached } from './ucpClient';

const PAY = process.argv.includes('--pay');
const BUYER = { first_name: 'Demo', last_name: 'Buyer', email: 'demo.buyer@example.com', phone_number: '+919876543210' };
let failures = 0;

const show = (title: string, res: { status: number; body: any }) => {
  console.log(`\n--- ${title}\nHTTP ${res.status}`);
  const text = JSON.stringify(res.body, null, 2);
  console.log(text.length > 1400 ? text.slice(0, 1400) + '\n  ...(truncated)' : text);
};
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`);
};
const section = (s: string) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  section('Test A - discovery: GET /.well-known/ucp');
  const profile = await fetch(`${BASE_URL}/.well-known/ucp`).then(async r => ({ status: r.status, body: await r.json() }));
  show('GET /.well-known/ucp', profile);
  check('200 with ucp.version', profile.status === 200 && !!profile.body.ucp?.version);
  check('only checkout capability advertised', Object.keys(profile.body.ucp.capabilities).join() === 'dev.ucp.shopping.checkout');
  check('no payment handler advertised', Object.keys(profile.body.ucp.payment_handlers).length === 0);

  section('Test B - product information (existing catalogue API; UCP 2026-01-23 has no catalog capability)');
  const products = await fetch(`${BASE_URL}/api/products?limit=20`).then(r => r.json());
  const product = products.data.find((p: any) => p.stock >= 5);
  console.log(`using "${product.name}" id=${product.id} price=${product.pricePaise} paise stock=${product.stock}`);
  check('product list returned', products.success && products.data.length > 0);

  section('Test C - create a checkout session (client sends a tampered price of 1 paise: Test G)');
  const created = await call('POST', '/checkout-sessions', {
    line_items: [{ item: { id: product.id, title: 'Free!', price: 1 }, quantity: 2 }],
  });
  show('POST /ucp/v1/checkout-sessions', created);
  const id = created.body.id;
  check('201 Created, status incomplete (buyer missing)', created.status === 201 && created.body.status === 'incomplete');
  check('G: server price used, not the submitted 1 paise', created.body.line_items[0].item.price === product.pricePaise);
  check('server-calculated total', created.body.totals.at(-1).amount === product.pricePaise * 2);

  section('Test D - retrieve the session');
  const got = await call('GET', `/checkout-sessions/${id}`);
  show(`GET /ucp/v1/checkout-sessions/${id}`, got);
  check('same content as create response', JSON.stringify(got.body) === JSON.stringify(created.body));

  section('Test E - update: change quantity 2 -> 3 and add buyer; total is recalculated by the server');
  const updated = await call('PUT', `/checkout-sessions/${id}`, {
    id,
    buyer: BUYER,
    line_items: [{ id: 'li_1', item: { id: product.id, price: 1 }, quantity: 3 }],
  });
  show(`PUT /ucp/v1/checkout-sessions/${id}`, updated);
  check('status ready_for_complete', updated.body.status === 'ready_for_complete');
  check('total = 3 x server price', updated.body.totals.at(-1).amount === product.pricePaise * 3);

  section('Test F - invalid product id / insufficient stock / bad quantity');
  const badProduct = await call('POST', '/checkout-sessions', { line_items: [{ item: { id: crypto.randomUUID() }, quantity: 1 }] });
  show('unknown product', badProduct);
  check('unknown product -> 400', badProduct.status === 400 && badProduct.body.messages[0].code === 'invalid');
  const tooMany = await call('POST', '/checkout-sessions', { line_items: [{ item: { id: product.id }, quantity: 100 }], buyer: BUYER });
  show('quantity above stock', tooMany);
  check('insufficient stock reported (out_of_stock)', tooMany.body.messages?.some((m: any) => m.code === 'out_of_stock'));
  const doneTooMany = await call('POST', `/checkout-sessions/${tooMany.body.id}/complete`, {});
  check('completing it is refused (409) and no order is created', doneTooMany.status === 409 && !doneTooMany.body.order);
  const badQty = await call('POST', '/checkout-sessions', { line_items: [{ item: { id: product.id }, quantity: -5 }] });
  check('negative quantity -> 400', badQty.status === 400);
  await call('POST', `/checkout-sessions/${tooMany.body.id}/cancel`);

  section('Test L - idempotency: same key + same body replays; same key + different body -> 409');
  const key = crypto.randomUUID();
  const body = { line_items: [{ item: { id: product.id }, quantity: 1 }] };
  const first = await call('POST', '/checkout-sessions', body, { headers: { 'Idempotency-Key': key } });
  const replay = await call('POST', '/checkout-sessions', body, { headers: { 'Idempotency-Key': key } });
  const conflict = await call('POST', '/checkout-sessions', { line_items: [{ item: { id: product.id }, quantity: 2 }] }, { headers: { 'Idempotency-Key': key } });
  show('replay (same key, same body)', replay);
  check('replay returns the identical session (no second session)', replay.body.id === first.body.id && replay.headers.get('idempotent-replayed') === 'true');
  check('same key, different body -> 409', conflict.status === 409 && conflict.body.messages[0].code === 'idempotency_key_reuse');
  await call('POST', `/checkout-sessions/${first.body.id}/cancel`);

  section('Test M - required headers, authentication and request signatures');
  const m = async (name: string, expected: number, opts: any, path = '/checkout-sessions/x', method = 'GET') => {
    const r = await call(method, path, undefined, opts);
    check(`${name} -> ${expected}`, r.status === expected, `got ${r.status} ${JSON.stringify(r.body?.messages?.[0])}`);
    return r;
  };
  await m('missing Request-Id', 400, { headers: { 'Request-Id': undefined } });
  await m('missing UCP-Agent', 400, { headers: { 'UCP-Agent': undefined } });
  await m('missing Idempotency-Key on POST', 400, { headers: { 'Idempotency-Key': undefined } }, '/checkout-sessions/x/cancel', 'POST');
  await m('unregistered platform', 403, { headers: { 'UCP-Agent': 'profile="https://evil.example/profile"' } });
  await m('missing API key', 401, { headers: { 'X-API-Key': undefined } });
  await m('wrong API key', 401, { headers: { 'X-API-Key': 'nope' } });
  await m('missing Request-Signature', 401, { noSignature: true });
  await m('signature over a different payload (tampered body)', 401, { signWith: 'something else' });
  const forged = (await signDetached('x')).replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
  await m('corrupted signature', 401, { headers: { 'Request-Signature': forged } });

  section('Test J (server side) - invalid payment verification is rejected and changes nothing');
  const badVerify = await fetch(`${BASE_URL}/api/payments/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: 'x', razorpay_order_id: 'order_x', razorpay_payment_id: 'pay_x', razorpay_signature: 'forged' }),
  });
  check('forged Razorpay signature -> 400', badVerify.status === 400, `got ${badVerify.status}`);
  const badHook = await fetch(`${BASE_URL}/api/payments/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('unsigned Razorpay webhook -> 400/503 (never accepted)', [400, 503].includes(badHook.status), `got ${badHook.status}`);

  section('Test K - cancel');
  const cancel = await call('POST', `/checkout-sessions/${id}/cancel`);
  show(`POST /ucp/v1/checkout-sessions/${id}/cancel`, cancel);
  check('status canceled', cancel.body.status === 'canceled');
  const afterCancel = await call('PUT', `/checkout-sessions/${id}`, { line_items: [{ item: { id: product.id }, quantity: 1 }] });
  check('update after cancel -> 409', afterCancel.status === 409);
  const completeCanceled = await call('POST', `/checkout-sessions/${id}/complete`, {});
  check('complete after cancel -> 409', completeCanceled.status === 409);
  const cancelAgain = await call('POST', `/checkout-sessions/${id}/cancel`);
  check('repeated cancel is safe (200, canceled)', cancelAgain.status === 200 && cancelAgain.body.status === 'canceled');

  if (PAY) {
    section('Tests H/I - complete checkout and pay with Razorpay (TEST mode)');
    const c = await call('POST', '/checkout-sessions', { line_items: [{ item: { id: product.id }, quantity: 1 }], buyer: BUYER });
    const done = await call('POST', `/checkout-sessions/${c.body.id}/complete`, {});
    show('POST .../complete', done);
    check('complete_in_progress with continue_url and order', done.body.status === 'complete_in_progress' && !!done.body.continue_url && !!done.body.order);
    const again = await call('POST', `/checkout-sessions/${c.body.id}/complete`, {});
    check('second complete returns the same order (no duplicate)', again.body.order?.id === done.body.order.id);
    console.log(`\n>>> Open this link and pay with a Razorpay TEST card (4111 1111 1111 1111, any future expiry/CVV, any OTP):\n    ${done.body.continue_url}\n`);
    console.log('Waiting up to 5 minutes for the payment to be verified...');
    let final: any;
    for (let i = 0; i < 100; i++) {
      await sleep(3000);
      final = await call('GET', `/checkout-sessions/${c.body.id}`);
      if (final.body.status !== 'complete_in_progress') break;
    }
    show('GET checkout after payment', final);
    check('checkout status completed', final.body.status === 'completed');
    const order = await fetch(`${BASE_URL}/api/orders/${done.body.order.id}`).then(r => r.json());
    check('MySQL order status PAID', order.data?.status === 'PAID');
    check('payment record PAID with Razorpay ids', order.data?.payment?.status === 'PAID' && !!order.data?.payment?.razorpayPaymentId);
    const dup = await call('POST', `/checkout-sessions/${c.body.id}/complete`, {});
    check('completing a completed checkout -> 409', dup.status === 409);
  } else {
    console.log('\n(Tests H/I skipped: run with --pay to complete a real order and pay with a Razorpay test card.)');
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
