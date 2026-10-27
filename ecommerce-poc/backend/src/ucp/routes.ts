import express, { NextFunction, Request, Response, Router } from 'express';
import { UcpError } from './errors';
import { ucpConfig } from './config';
import {
  authenticate,
  createRateLimiter,
  ctx,
  errorHandler,
  idempotency,
  parseBody,
  requireHeaders,
  verifySignature,
} from './middleware';
import { cancelCheckout, completeCheckout, createCheckout, getCheckout, updateCheckout } from './checkoutService';

type Op = (req: Request) => Promise<{ status: number; body: unknown }>;

const handle =
  (op: Op) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, body } = await op(req);
      res.status(status).json(body);
    } catch (err) {
      next(err);
    }
  };

// REST binding of dev.ucp.shopping (checkout capability), mounted at /ucp/v1.
export const createUcpRouter = (opts: { rateLimitPerMinute?: number } = {}): Router => {
  const router = Router();
  const profile = (req: Request) => ctx(req).platform.profile;

  router.use(createRateLimiter(opts.rateLimitPerMinute ?? ucpConfig().rateLimitPerMinute));
  router.use(express.raw({ type: () => true, limit: '64kb' }));
  router.use(parseBody, requireHeaders, authenticate, verifySignature, idempotency);

  router.post('/checkout-sessions', handle(req => createCheckout(profile(req), ctx(req).body)));
  router.get('/checkout-sessions/:id', handle(req => getCheckout(profile(req), req.params.id)));
  router.put('/checkout-sessions/:id', handle(req => updateCheckout(profile(req), req.params.id, ctx(req).body)));
  router.post('/checkout-sessions/:id/complete', handle(req => completeCheckout(profile(req), req.params.id, ctx(req).body)));
  router.post('/checkout-sessions/:id/cancel', handle(req => cancelCheckout(profile(req), req.params.id)));

  router.use((_req, _res, next) => next(new UcpError(404, 'not_found', 'Unknown UCP endpoint.')));
  router.use(errorHandler);
  return router;
};
