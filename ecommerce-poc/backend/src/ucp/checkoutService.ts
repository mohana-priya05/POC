import Joi from 'joi';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { createPendingOrder } from '../services/orderService';
import { ucpConfig } from './config';
import { UcpError, UcpMessage, ucpMeta } from './errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CheckoutStatus =
  | 'incomplete'
  | 'requires_escalation'
  | 'ready_for_complete'
  | 'complete_in_progress'
  | 'completed'
  | 'canceled';

interface StoredLine {
  id: string;
  productId: string;
  quantity: number;
}

interface Buyer {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_number?: string;
}

const OPEN: CheckoutStatus[] = ['incomplete', 'ready_for_complete'];
const isOpen = (s: string) => (OPEN as string[]).includes(s);

// ---------------------------------------------------------------------------
// Request validation (derived from the ucp_request annotations in the official
// schemas: line_items required on create/update, status/totals/etc. are response-only).
// Unknown members are allowed because the schemas set additionalProperties: true;
// client-supplied prices/titles are accepted but never used.
// ---------------------------------------------------------------------------

const lineItemSchema = Joi.object({
  id: Joi.string().max(64),
  item: Joi.object({ id: Joi.string().min(1).max(64).required() }).unknown(true).required(),
  quantity: Joi.number().integer().min(1).max(100).required(),
}).unknown(true);

const buyerSchema = Joi.object({
  first_name: Joi.string().max(100).allow(''),
  last_name: Joi.string().max(100).allow(''),
  email: Joi.string().email().max(255),
  phone_number: Joi.string().pattern(/^\+[1-9]\d{6,14}$/), // E.164
}).unknown(true);

const createSchema = Joi.object({
  line_items: Joi.array().items(lineItemSchema).min(1).max(50).required(),
  buyer: buyerSchema,
  context: Joi.object().unknown(true),
  payment: Joi.object().unknown(true),
}).unknown(true);

const updateSchema = createSchema.keys({ id: Joi.string().max(64) });
const completeSchema = Joi.object({ payment: Joi.object().unknown(true), risk_signals: Joi.object().unknown(true) }).unknown(true);

const jsonPath = (p: (string | number)[]) =>
  '$' + p.map(seg => (typeof seg === 'number' ? `[${seg}]` : `.${seg}`)).join('');

const validate = <T>(schema: Joi.ObjectSchema, body: unknown): T => {
  const { value, error } = schema.validate(body, { abortEarly: false, convert: false });
  if (error) {
    const err = new UcpError(400, 'invalid', 'Request validation failed.');
    err.messages = error.details.map(d => ({
      type: 'error' as const,
      code: d.type === 'any.required' ? 'missing' : 'invalid',
      path: jsonPath(d.path),
      content: d.message.replace(/"/g, "'"),
      severity: 'recoverable' as const,
    }));
    throw err;
  }
  return value as T;
};

// ---------------------------------------------------------------------------
// Line items: the client only contributes (product id, quantity). Everything else is read
// from the database.
// ---------------------------------------------------------------------------

const normalizeLines = (raw: any[]): StoredLine[] => {
  const merged = new Map<string, StoredLine>();
  raw.forEach((li, idx) => {
    const productId = li.item.id as string;
    const existing = merged.get(productId);
    if (existing) {
      existing.quantity += li.quantity;
    } else {
      merged.set(productId, { id: li.id || `li_${idx + 1}`, productId, quantity: li.quantity });
    }
  });
  const lines = [...merged.values()];
  if (lines.some(l => l.quantity > 100)) {
    throw new UcpError(400, 'invalid', 'Quantity per product may not exceed 100.', 'recoverable', '$.line_items');
  }
  return lines;
};

const normalizeBuyer = (b: any): Buyer | null => {
  if (!b) return null;
  const out: Buyer = {};
  for (const k of ['first_name', 'last_name', 'email', 'phone_number'] as const) {
    if (b[k]) out[k] = b[k];
  }
  return Object.keys(out).length ? out : null;
};

type Product = NonNullable<Awaited<ReturnType<typeof prisma.product.findFirst>>>;

const lineProblems = (lines: StoredLine[], products: Product[]): UcpMessage[] => {
  const msgs: UcpMessage[] = [];
  lines.forEach((l, i) => {
    const p = products.find(x => x.id === l.productId);
    if (!p || !p.active) {
      msgs.push({
        type: 'error',
        code: 'invalid',
        path: `$.line_items[${i}].item.id`,
        content: 'Product does not exist or is no longer available.',
        severity: 'recoverable',
      });
    } else if (p.stock < l.quantity) {
      msgs.push({
        type: 'error',
        code: 'out_of_stock',
        path: `$.line_items[${i}].quantity`,
        content: p.stock > 0 ? `Only ${p.stock} unit(s) of "${p.name}" available.` : `"${p.name}" is out of stock.`,
        severity: 'recoverable',
      });
    }
  });
  return msgs;
};

const buyerProblems = (buyer: Buyer | null): UcpMessage[] => {
  const need: [string, boolean][] = [
    ['$.buyer.email', !buyer?.email],
    ['$.buyer.phone_number', !buyer?.phone_number],
    ['$.buyer.first_name', !buyer?.first_name && !buyer?.last_name],
  ];
  return need
    .filter(([, missing]) => missing)
    .map(([path]) => ({
      type: 'error' as const,
      code: 'missing',
      path,
      content: `${path.replace('$.buyer.', '')} is required to place the order.`,
      severity: 'recoverable' as const,
    }));
};

// ---------------------------------------------------------------------------
// Checkout resource
// ---------------------------------------------------------------------------

const ORDER_STATUS_TO_CHECKOUT: Record<string, CheckoutStatus> = {
  PENDING: 'complete_in_progress',
  PAID: 'completed',
  FAILED: 'canceled',
  CANCELLED: 'canceled',
};

const loadSession = async (id: string, platformProfile: string) => {
  const session = await prisma.checkoutSession.findUnique({ where: { id } });
  // A platform can only see its own sessions; anything else looks like "not found".
  if (!session || session.platformProfile !== platformProfile) {
    throw new UcpError(404, 'not_found', 'Checkout session not found.');
  }
  return session;
};

type Session = Awaited<ReturnType<typeof loadSession>>;

// Builds the response from database state and brings the stored status in line with it
// (order paid -> completed, session expired -> canceled).
const render = async (session: Session) => {
  const cfg = ucpConfig();
  const lines = session.lineItems as unknown as StoredLine[];
  const buyer = (session.buyer as Buyer | null) ?? null;

  const [products, order] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: lines.map(l => l.productId) } } }),
    session.orderId
      ? prisma.order.findUnique({ where: { id: session.orderId }, include: { orderItems: true } })
      : Promise.resolve(null),
  ]);

  let status = session.status as CheckoutStatus;
  const messages: UcpMessage[] = [];

  if (order) {
    status = ORDER_STATUS_TO_CHECKOUT[order.status] ?? status;
  } else if (isOpen(status) && session.expiresAt.getTime() <= Date.now()) {
    status = 'canceled';
    messages.push({ type: 'info', code: 'expired', content: 'This checkout session has expired.' });
  } else if (isOpen(status)) {
    const problems = [...buyerProblems(buyer), ...lineProblems(lines, products)];
    messages.push(...problems);
    status = problems.length ? 'incomplete' : 'ready_for_complete';
  }

  if (status !== session.status) {
    await prisma.checkoutSession
      .updateMany({ where: { id: session.id, status: session.status }, data: { status } })
      .catch(() => undefined);
  }

  if (status === 'canceled' && !messages.length) {
    messages.push({ type: 'info', code: 'canceled', content: 'This checkout session was canceled.' });
  }
  if (status === 'complete_in_progress') {
    messages.push({
      type: 'info',
      code: 'payment_pending',
      content: 'Order created. The buyer must finish payment on continue_url (Razorpay Checkout).',
    });
  }

  const resourceLines = lines.map(l => {
    const p = products.find(x => x.id === l.productId);
    // After an order exists its frozen prices win over the live product price.
    const frozen = order?.orderItems.find(oi => oi.productId === l.productId);
    const unit = frozen ? frozen.pricePaise : p?.pricePaise ?? 0;
    const amount = unit * l.quantity;
    const images = (p?.images as string[] | undefined) ?? [];
    return {
      id: l.id,
      item: {
        id: l.productId,
        title: p?.name ?? 'Unavailable product',
        price: unit,
        ...(images[0] ? { image_url: images[0] } : {}),
      },
      quantity: l.quantity,
      totals: [
        { type: 'subtotal', amount },
        { type: 'total', amount },
      ],
    };
  });
  const subtotal = resourceLines.reduce((sum, l) => sum + l.totals[0].amount, 0);

  const terminal = status === 'completed' || status === 'canceled';
  return {
    ucp: ucpMeta(),
    id: session.id,
    status,
    currency: session.currency,
    line_items: resourceLines,
    ...(buyer ? { buyer } : {}),
    totals: [
      { type: 'subtotal', amount: subtotal },
      { type: 'total', amount: subtotal },
    ],
    ...(messages.length ? { messages } : {}),
    links: [
      { type: 'terms_of_service', url: cfg.termsUrl || `${cfg.frontendUrl}/terms` },
      { type: 'privacy_policy', url: cfg.privacyUrl || `${cfg.frontendUrl}/privacy` },
    ],
    expires_at: session.expiresAt.toISOString(),
    // Only the payment hand-off has a web destination in this application.
    ...(session.orderId && !terminal ? { continue_url: `${cfg.frontendUrl}/payment/${session.orderId}` } : {}),
    ...(session.orderId ? { order: { id: session.orderId, permalink_url: `${cfg.frontendUrl}/order/${session.orderId}` } } : {}),
  };
};

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const createCheckout = async (platformProfile: string, body: unknown) => {
  const input = validate<any>(createSchema, body);
  const lines = normalizeLines(input.line_items);

  const products = await prisma.product.findMany({ where: { id: { in: lines.map(l => l.productId) } } });
  const unknown = lines.flatMap((l, i) =>
    products.some(p => p.id === l.productId && p.active)
      ? []
      : [
          {
            type: 'error' as const,
            code: 'invalid',
            path: `$.line_items[${i}].item.id`,
            content: 'Product does not exist or is no longer available.',
            severity: 'recoverable' as const,
          },
        ]
  );
  if (unknown.length) {
    const err = new UcpError(400, 'invalid_cart_items', 'One or more cart items are invalid.');
    err.messages = unknown;
    throw err;
  }

  const session = await prisma.checkoutSession.create({
    data: {
      id: `chk_${crypto.randomUUID().replace(/-/g, '')}`,
      status: 'incomplete',
      currency: 'INR',
      lineItems: lines as any,
      buyer: (normalizeBuyer(input.buyer) as any) ?? undefined,
      platformProfile,
      expiresAt: new Date(Date.now() + ucpConfig().sessionTtlMs),
    },
  });
  return { status: 201, body: await render(session) };
};

export const getCheckout = async (platformProfile: string, id: string) => {
  const session = await loadSession(id, platformProfile);
  return { status: 200, body: await render(session) };
};

export const updateCheckout = async (platformProfile: string, id: string, body: unknown) => {
  const input = validate<any>(updateSchema, body);
  if (input.id && input.id !== id) {
    throw new UcpError(400, 'invalid', 'Body id does not match the checkout id in the path.', 'recoverable', '$.id');
  }
  const session = await loadSession(id, platformProfile);
  const current = await render(session); // applies expiry/order-derived status first
  if (!isOpen(current.status)) {
    throw modificationError(current.status);
  }

  const lines = normalizeLines(input.line_items);
  const products = await prisma.product.findMany({ where: { id: { in: lines.map(l => l.productId) } } });
  const unknown = lines.filter(l => !products.some(p => p.id === l.productId && p.active));
  if (unknown.length) {
    const err = new UcpError(400, 'invalid_cart_items', 'One or more cart items are invalid.');
    err.messages = lineProblems(lines, products).filter(m => m.code === 'invalid');
    throw err;
  }

  // PUT is a full replacement; the status guard makes it lose cleanly against a concurrent
  // complete/cancel instead of editing a session that already has an order.
  const updated = await prisma.checkoutSession.updateMany({
    where: { id, status: { in: OPEN }, orderId: null },
    data: { lineItems: lines as any, buyer: (normalizeBuyer(input.buyer) as any) ?? Prisma.DbNull },
  });
  if (updated.count === 0) throw modificationError('complete_in_progress');

  return { status: 200, body: await render(await loadSession(id, platformProfile)) };
};

const modificationError = (status: string) =>
  new UcpError(409, 'checkout_not_modifiable', `Checkout is ${status} and can no longer be modified.`);

export const completeCheckout = async (platformProfile: string, id: string, body: unknown) => {
  // `payment` is validated but never read or stored: card data must not reach this server.
  // Payment is taken by the existing Razorpay Checkout page (see continue_url).
  validate(completeSchema, body);

  const session = await loadSession(id, platformProfile);
  const current = await render(session);

  if (current.status === 'completed') throw modificationError('completed');
  if (current.status === 'canceled') throw modificationError('canceled');
  // Retrying complete while payment is pending must never create a second order.
  if (current.status === 'complete_in_progress') return { status: 200, body: current };

  if (current.status === 'incomplete') {
    const stockProblem = (current.messages ?? []).some(m => m.code === 'out_of_stock');
    return { status: stockProblem ? 409 : 400, body: current };
  }

  const lines = session.lineItems as unknown as StoredLine[];
  const buyer = session.buyer as Buyer;

  await prisma.$transaction(async tx => {
    const products = await tx.product.findMany({ where: { id: { in: lines.map(l => l.productId) } } });
    const problems = lineProblems(lines, products);
    if (problems.length) {
      const err = new UcpError(409, 'out_of_stock', 'Items changed since the checkout was prepared.');
      err.messages = problems;
      throw err;
    }

    // Exactly one concurrent complete wins this conditional transition.
    const claimed = await tx.checkoutSession.updateMany({
      where: { id, status: { in: OPEN }, orderId: null },
      data: { status: 'complete_in_progress' },
    });
    if (claimed.count === 0) return;

    const order = await createPendingOrder(tx, {
      customerName: [buyer.first_name, buyer.last_name].filter(Boolean).join(' '),
      customerEmail: buyer.email!,
      customerPhone: buyer.phone_number!,
      deliveryAddress: 'Not provided via UCP (fulfillment capability not implemented)',
      lines: lines.map(l => ({
        productId: l.productId,
        quantity: l.quantity,
        pricePaise: products.find(p => p.id === l.productId)!.pricePaise, // server-side price
      })),
    });
    await tx.checkoutSession.update({ where: { id }, data: { orderId: order.id } });
  });

  return { status: 200, body: await render(await loadSession(id, platformProfile)) };
};

export const cancelCheckout = async (platformProfile: string, id: string) => {
  const session = await loadSession(id, platformProfile);
  const current = await render(session);

  if (current.status === 'canceled') return { status: 200, body: current };
  if (current.status === 'completed') throw modificationError('completed');

  if (current.status === 'complete_in_progress') {
    // Once the buyer has opened Razorpay Checkout money may already be in flight.
    const payment = await prisma.payment.findUnique({ where: { orderId: session.orderId! } });
    if (payment?.razorpayOrderId) {
      throw new UcpError(409, 'cancel_not_allowed', 'Payment has already been initiated and cannot be canceled here.');
    }
    await prisma.$transaction(async tx => {
      const res = await tx.order.updateMany({ where: { id: session.orderId!, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      if (res.count === 0) throw modificationError('completed');
      await tx.checkoutSession.update({ where: { id }, data: { status: 'canceled' } });
    });
  } else {
    const res = await prisma.checkoutSession.updateMany({ where: { id, status: { in: OPEN }, orderId: null }, data: { status: 'canceled' } });
    if (res.count === 0) throw modificationError('complete_in_progress');
  }

  return { status: 200, body: await render(await loadSession(id, platformProfile)) };
};
