/** Minimal signing UCP platform client used by the demo and the manual-call CLI. */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FlattenedSign, importJWK } from 'jose';

export const BASE_URL = (process.env.UCP_BASE_URL || 'http://localhost:5000').replace(/\/+$/, '');

export const loadCredentials = () => {
  const file = path.resolve(__dirname, '..', '.ucp-test-platform', 'credentials.json');
  if (!fs.existsSync(file)) throw new Error('Run `npm run ucp:setup` first.');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as { profile: string; apiKey: string; privateJwk: any };
};

export interface CallOptions {
  headers?: Record<string, string | undefined>; // override or (with undefined) drop headers
  rawBody?: string; // send exactly this string instead of JSON.stringify(body)
  signWith?: string; // sign this payload instead of the real body (tamper tests)
  noSignature?: boolean;
}

export const signDetached = async (payload: string) => {
  const { privateJwk } = loadCredentials();
  const key = await importJWK(privateJwk, 'ES256');
  const jws = await new FlattenedSign(Buffer.from(payload, 'utf8'))
    .setProtectedHeader({ alg: 'ES256', kid: privateJwk.kid, b64: false, crit: ['b64'] })
    .sign(key);
  return `${jws.protected}..${jws.signature}`;
};

export const buildHeaders = async (method: string, bodyStr: string, opts: CallOptions = {}) => {
  const creds = loadCredentials();
  const headers: Record<string, string | undefined> = {
    'UCP-Agent': `profile="${creds.profile}"`,
    'Request-Id': crypto.randomUUID(),
    'X-API-Key': creds.apiKey,
    Accept: 'application/json',
  };
  if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();
  if (bodyStr) headers['Content-Type'] = 'application/json';
  if (!opts.noSignature) headers['Request-Signature'] = await signDetached(opts.signWith ?? bodyStr);
  Object.assign(headers, opts.headers);
  return Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)) as Record<string, string>;
};

export const call = async (method: string, urlPath: string, body?: unknown, opts: CallOptions = {}) => {
  const bodyStr = opts.rawBody ?? (body === undefined ? '' : JSON.stringify(body));
  const headers = await buildHeaders(method, bodyStr, opts);
  const url = urlPath.startsWith('/.well-known') ? `${BASE_URL}${urlPath}` : `${BASE_URL}/ucp/v1${urlPath}`;
  const res = await fetch(url, { method, headers, body: bodyStr || undefined });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, body: json, sent: { url, headers, body: bodyStr } };
};
