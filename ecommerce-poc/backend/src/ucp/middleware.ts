import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { flattenedVerify, importJWK, decodeProtectedHeader } from 'jose';
import prisma from '../utils/prisma';
import { UcpError } from './errors';
import { apiKeyMatches, findPlatformByProfile, TrustedPlatform } from './platforms';

export interface UcpContext {
  platform: TrustedPlatform;
  profileUri: string;
  requestId: string;
  rawBody: Buffer;
  body: any;
}

export const ctx = (req: Request) => (req as any).ucp as UcpContext;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const sha256 = (data: crypto.BinaryLike) => crypto.createHash('sha256').update(data).digest('hex');

export const createRateLimiter = (perMinute: number) =>
  rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      const err = new UcpError(429, 'rate_limited', 'Too many requests. Retry after the interval in the RateLimit headers.');
      res.status(429).json(err.toBody());
    },
  });

// Body arrives as raw bytes: the exact bytes are needed to verify Request-Signature and to
// fingerprint requests for idempotency. JSON is parsed here.
export const parseBody = (req: Request, _res: Response, next: NextFunction) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let body: any = {};
  if (rawBody.length > 0) {
    if (!(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
      return next(new UcpError(400, 'invalid_content_type', 'Content-Type must be application/json.'));
    }
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return next(new UcpError(400, 'invalid_json', 'Request body is not valid JSON.'));
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return next(new UcpError(400, 'invalid_json', 'Request body must be a JSON object.'));
    }
  }
  (req as any).ucp = { rawBody, body } as Partial<UcpContext>;
  next();
};

// RFC 8941 Dictionary: only the `profile` string member is needed.
export const parseUcpAgentProfile = (header: string | undefined): string | null => {
  if (!header) return null;
  const m = header.match(/(?:^|,)\s*profile\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
};

export const requireHeaders = (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.header('Request-Id');
  if (!requestId || !UUID_RE.test(requestId)) {
    return next(new UcpError(400, 'invalid_header', 'Request-Id header is required and must be a UUID.'));
  }
  res.setHeader('Request-Id', requestId);

  const profile = parseUcpAgentProfile(req.header('UCP-Agent'));
  if (!profile) {
    return next(new UcpError(400, 'invalid_header', 'UCP-Agent header is required: profile="<platform profile URI>".'));
  }
  ctx(req).profileUri = profile;
  ctx(req).requestId = requestId;

  if (MUTATING.has(req.method)) {
    const key = req.header('Idempotency-Key');
    if (!key || !UUID_RE.test(key)) {
      return next(new UcpError(400, 'invalid_header', 'Idempotency-Key header is required and must be a UUID.'));
    }
  }
  next();
};

export const authenticate = (req: Request, _res: Response, next: NextFunction) => {
  const platform = findPlatformByProfile(ctx(req).profileUri);
  if (!platform) {
    return next(new UcpError(403, 'unknown_platform', 'The platform in UCP-Agent is not registered with this business.'));
  }
  const apiKey = req.header('X-API-Key');
  if (!apiKey) {
    return next(new UcpError(401, 'unauthorized', 'X-API-Key header is required.'));
  }
  if (!apiKeyMatches(platform, apiKey)) {
    return next(new UcpError(401, 'unauthorized', 'Invalid API key.'));
  }
  ctx(req).platform = platform;
  next();
};

// Request-Signature: detached JWS (RFC 7797, unencoded payload) over the exact request body
// bytes, signed with ES256. `kid` selects a key from the platform's registered signing_keys.
// The 2026-01-23 REST binding marks the header required but only defines the format for
// webhooks, so the webhook format is applied to requests as well (documented limitation).
export const verifySignature = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const header = req.header('Request-Signature');
    if (!header) throw new UcpError(401, 'signature_required', 'Request-Signature header is required.');

    const parts = header.split('.');
    if (parts.length !== 3 || parts[1] !== '') {
      throw new UcpError(401, 'invalid_signature', 'Request-Signature must be a detached JWS (header..signature).');
    }
    let protectedHeader: any;
    try {
      protectedHeader = decodeProtectedHeader({ protected: parts[0] } as any);
    } catch {
      throw new UcpError(401, 'invalid_signature', 'Request-Signature header is malformed.');
    }
    if (protectedHeader.alg !== 'ES256' || protectedHeader.b64 !== false) {
      throw new UcpError(401, 'invalid_signature', 'Signature must use ES256 with unencoded payload (b64=false).');
    }
    const jwk = ctx(req).platform.signing_keys.find(k => k.kid === protectedHeader.kid);
    if (!jwk) throw new UcpError(401, 'invalid_signature', 'Unknown signing key id (kid).');

    const key = await importJWK(jwk as any, 'ES256');
    await flattenedVerify({ protected: parts[0], payload: ctx(req).rawBody, signature: parts[2] }, key, {
      algorithms: ['ES256'],
    });
    next();
  } catch (err) {
    if (err instanceof UcpError) return next(err);
    next(new UcpError(401, 'invalid_signature', 'Request signature verification failed.'));
  }
};

// Stores the result of every mutating call (kept 48h) keyed by (platform, method, path, key).
// Same key + same body -> stored response is replayed. Same key + different body -> 409.
export const idempotency = async (req: Request, res: Response, next: NextFunction) => {
  if (!MUTATING.has(req.method)) return next();
  const key = req.header('Idempotency-Key')!;
  const scope = `${ctx(req).platform.name}|${req.method}|${req.baseUrl}${req.path}`.slice(0, 255);
  const requestHash = sha256(ctx(req).rawBody);

  try {
    if (Math.random() < 0.01) {
      prisma.idempotencyRecord
        .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 48 * 3600 * 1000) } } })
        .catch(() => undefined);
    }

    let record;
    try {
      record = await prisma.idempotencyRecord.create({
        data: { scope, idemKey: key, requestHash, state: 'IN_PROGRESS' },
      });
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
      const existing = await prisma.idempotencyRecord.findUnique({ where: { scope_idemKey: { scope, idemKey: key } } });
      if (!existing) throw err;
      if (existing.requestHash !== requestHash) {
        throw new UcpError(409, 'idempotency_key_reuse', 'Idempotency-Key was already used with different request parameters.');
      }
      if (existing.state !== 'DONE') {
        throw new UcpError(409, 'request_in_progress', 'A request with this Idempotency-Key is still being processed.');
      }
      res.setHeader('Idempotent-Replayed', 'true');
      return res.status(existing.responseStatus || 200).json(existing.responseBody);
    }

    const sendJson = res.json.bind(res);
    (res as any).json = (body: any) => {
      const persist =
        res.statusCode >= 500
          ? prisma.idempotencyRecord.delete({ where: { id: record!.id } }) // let the client retry
          : prisma.idempotencyRecord.update({
              where: { id: record!.id },
              data: { state: 'DONE', responseStatus: res.statusCode, responseBody: body },
            });
      persist.catch(e => console.error('idempotency persist failed', e)).finally(() => sendJson(body));
      return res;
    };
    next();
  } catch (err) {
    next(err);
  }
};

export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof UcpError) return res.status(err.status).json(err.toBody());
  if (err?.type === 'entity.too.large') {
    return res.status(413).json(new UcpError(413, 'payload_too_large', 'Request body too large.').toBody());
  }
  console.error('UCP unhandled error:', err);
  res.status(500).json(new UcpError(500, 'internal_error', 'Internal server error.').toBody());
};
