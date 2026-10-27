/**
 * Website chatbot API (browser-facing). Conversation goes to Gemini; checkout goes through the
 * existing UCP checkout API as a registered platform (see ucpPlatformClient.ts). Payment is NOT
 * handled here: the chat UI uses the existing /api/payments endpoints, and the order is shown as
 * paid only when the database says so after server-side Razorpay verification.
 */
import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import Joi from 'joi';
import prisma from '../utils/prisma';
import { askAssistant, GeminiError } from './gemini';
import { searchCatalog } from './productSearch';
import { ChatUcpError, idempotencyKeyFor, ucpRequest } from './ucpPlatformClient';

const CHECKOUT_ID = /^chk_[a-f0-9]{32}$/;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const messageSchema = Joi.object({
  message: Joi.string().trim().min(1).max(500).required(),
  history: Joi.array()
    .items(Joi.object({ role: Joi.string().valid('user', 'assistant').required(), text: Joi.string().max(1500).required() }))
    .max(12)
    .default([]),
});

const buyerSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  email: Joi.string().trim().email().max(255).required(),
  phone: Joi.string().trim().required(),
});

const startSchema = Joi.object({
  productId: Joi.string().min(1).max(64).required(),
  quantity: Joi.number().integer().min(1).max(100).required(),
  requestId: Joi.string().uuid().required(), // one per "Buy now" click: double submits replay, never duplicate
});

const patchSchema = Joi.object({
  quantity: Joi.number().integer().min(1).max(100),
  buyer: buyerSchema,
}).or('quantity', 'buyer');

/** Indian 10-digit numbers get +91; anything else must already be E.164. */
export const normalizePhone = (raw: string): string | null => {
  const compact = raw.replace(/[\s\-().]/g, '');
  if (/^[6-9]\d{9}$/.test(compact)) return `+91${compact}`;
  if (/^\+?91[6-9]\d{9}$/.test(compact)) return `+${compact.replace(/^\+/, '')}`;
  return /^\+[1-9]\d{6,14}$/.test(compact) ? compact : null;
};

const toUcpBuyer = (b: { name: string; email: string; phone: string }) => {
  const phone = normalizePhone(b.phone);
  if (!phone) throw new ChatUcpError(400, 'invalid_phone', 'Enter a valid phone number (10-digit Indian mobile or +country code).');
  const [first, ...rest] = b.name.trim().split(/\s+/);
  return { first_name: first, ...(rest.length ? { last_name: rest.join(' ') } : {}), email: b.email, phone_number: phone };
};

const validateBody = <T>(schema: Joi.ObjectSchema, body: unknown): T => {
  const { value, error } = schema.validate(body, { abortEarly: false, stripUnknown: true });
  if (error) throw new ChatUcpError(400, 'invalid_request', error.details.map(d => d.message.replace(/"/g, "'")).join('; '));
  return value as T;
};

const checkoutId = (req: Request) => {
  if (!CHECKOUT_ID.test(req.params.id)) throw new ChatUcpError(404, 'not_found', 'Checkout not found.');
  return req.params.id;
};

// ---------------------------------------------------------------------------
// View: what the browser may see. Built from the UCP response plus the order row in MySQL.
// ---------------------------------------------------------------------------

const buildView = async (ucp: any) => {
  const orderId: string | undefined = ucp.order?.id;
  let order: any = null;
  if (orderId) {
    const row = await prisma.order.findUnique({
      where: { id: orderId },
      include: { orderItems: { include: { product: true } }, payment: true },
    });
    if (row) {
      order = {
        id: row.id,
        orderNumber: row.orderNumber,
        status: row.status,
        paymentStatus: row.payment?.status ?? null,
        totalPaise: row.totalPaise,
        paid: row.status === 'PAID' && row.payment?.status === 'PAID',
        items: row.orderItems.map(i => ({ name: i.product.name, quantity: i.quantity, subtotalPaise: i.subtotalPaise })),
      };
    }
  }
  return {
    id: ucp.id,
    status: ucp.status,
    lineItems: (ucp.line_items ?? []).map((l: any) => ({
      productId: l.item.id,
      title: l.item.title,
      image: l.item.image_url ?? null,
      unitPaise: l.item.price,
      quantity: l.quantity,
      subtotalPaise: l.totals?.find((t: any) => t.type === 'subtotal')?.amount ?? l.item.price * l.quantity,
    })),
    totalPaise: ucp.totals?.find((t: any) => t.type === 'total')?.amount ?? 0,
    buyer: ucp.buyer ?? null,
    messages: (ucp.messages ?? []).map((m: any) => ({ type: m.type, code: m.code, content: m.content })),
    order,
  };
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export const createChatRouter = (opts: { rateLimitPerMinute?: number } = {}) => {
  const router = Router();

  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: opts.rateLimitPerMinute ?? Number(process.env.CHAT_RATE_LIMIT_PER_MIN || 60),
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, code: 'rate_limited', message: 'Too many requests. Please slow down.' },
    })
  );

  router.post(
    '/message',
    wrap(async (req, res) => {
      const { message, history } = validateBody<{ message: string; history: any[] }>(messageSchema, req.body);
      try {
        const out = await askAssistant(history, message);
        return res.json({ success: true, data: { ...out, aiAvailable: true } });
      } catch (err) {
        if (!(err instanceof GeminiError)) throw err;
        console.error('[chat] Gemini unavailable:', err.code, err.message);
        // Degrade gracefully: plain catalogue search so shopping still works.
        const products = await searchCatalog({ query: message });
        return res.json({
          success: true,
          data: {
            aiAvailable: false,
            reply: products.length
              ? 'The AI assistant is unavailable right now, but here are matching products from our catalogue.'
              : 'The AI assistant is unavailable right now and I found no matching products. Please try again shortly.',
            products,
          },
        });
      }
    })
  );

  router.post(
    '/checkout',
    wrap(async (req, res) => {
      const { productId, quantity, requestId } = validateBody<any>(startSchema, req.body);
      const ucp = await ucpRequest(
        'POST',
        '/checkout-sessions',
        { line_items: [{ item: { id: productId }, quantity }] },
        idempotencyKeyFor(`create:${requestId}`)
      );
      res.status(201).json({ success: true, data: await buildView(ucp) });
    })
  );

  router.get(
    '/checkout/:id',
    wrap(async (req, res) => {
      const ucp = await ucpRequest('GET', `/checkout-sessions/${checkoutId(req)}`);
      res.json({ success: true, data: await buildView(ucp) });
    })
  );

  router.patch(
    '/checkout/:id',
    wrap(async (req, res) => {
      const id = checkoutId(req);
      const patch = validateBody<{ quantity?: number; buyer?: any }>(patchSchema, req.body);
      const current = await ucpRequest('GET', `/checkout-sessions/${id}`);
      // UCP update is a full replacement: resend the existing lines with the changed quantity.
      const line_items = (current.line_items ?? []).map((l: any) => ({
        id: l.id,
        item: { id: l.item.id },
        quantity: patch.quantity ?? l.quantity,
      }));
      const buyer = patch.buyer ? toUcpBuyer(patch.buyer) : current.buyer;
      const ucp = await ucpRequest('PUT', `/checkout-sessions/${id}`, { id, line_items, ...(buyer ? { buyer } : {}) });
      res.json({ success: true, data: await buildView(ucp) });
    })
  );

  router.post(
    '/checkout/:id/complete',
    wrap(async (req, res) => {
      const id = checkoutId(req);
      const ucp = await ucpRequest('POST', `/checkout-sessions/${id}/complete`, {}, idempotencyKeyFor(`complete:${id}`));
      res.json({ success: true, data: await buildView(ucp) });
    })
  );

  router.post(
    '/checkout/:id/cancel',
    wrap(async (req, res) => {
      const ucp = await ucpRequest('POST', `/checkout-sessions/${checkoutId(req)}/cancel`, {});
      res.json({ success: true, data: await buildView(ucp) });
    })
  );

  router.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ChatUcpError) {
      // 401/403 from UCP mean the chatbot's own platform registration is broken, not the shopper's fault.
      const status = err.status === 401 || err.status === 403 ? 502 : err.status;
      if (status === 502) console.error('[chat] UCP rejected the chatbot platform:', err.code, err.message);
      return res.status(status).json({
        success: false,
        code: err.code,
        message: status === 502 && err.status !== 502 ? 'Checkout is temporarily unavailable.' : err.message,
        messages: err.messages.map(m => ({ type: m.type, code: m.code, content: m.content })),
      });
    }
    console.error('[chat]', err);
    res.status(500).json({ success: false, code: 'internal', message: 'Something went wrong.' });
  });

  return router;
};
