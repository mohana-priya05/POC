/**
 * Server-side UCP platform client used by the website chatbot.
 *
 * The browser can never hold a platform API key or signing key, so the chatbot backend acts as a
 * registered UCP platform ("website-chat-assistant") and calls /ucp/v1 over HTTP exactly like any
 * other platform: API key, detached ES256 request signature, Request-Id and Idempotency-Key. The
 * UCP security layers are therefore exercised, not bypassed.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FlattenedSign, importJWK, KeyLike } from 'jose';

export interface ChatPlatformCredentials {
  profile: string;
  apiKey: string;
  privateJwk: any;
}

export const CHAT_CREDENTIALS_FILE = path.resolve(__dirname, '..', '..', '.ucp-test-platform', 'chat-credentials.json');

export const loadChatCredentials = (): ChatPlatformCredentials => {
  if (process.env.CHAT_UCP_API_KEY && process.env.CHAT_UCP_PRIVATE_JWK && process.env.CHAT_UCP_PROFILE) {
    return {
      profile: process.env.CHAT_UCP_PROFILE,
      apiKey: process.env.CHAT_UCP_API_KEY,
      privateJwk: JSON.parse(process.env.CHAT_UCP_PRIVATE_JWK),
    };
  }
  if (!fs.existsSync(CHAT_CREDENTIALS_FILE)) {
    throw new ChatUcpError(503, 'chat_platform_not_registered', 'Run `npm run ucp:register-chat` to register the chatbot as a UCP platform.');
  }
  return JSON.parse(fs.readFileSync(CHAT_CREDENTIALS_FILE, 'utf8'));
};

export class ChatUcpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public messages: any[] = []
  ) {
    super(message);
  }
}

const baseUrl = () => (process.env.CHAT_UCP_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5000}`).replace(/\/+$/, '');

let cachedKey: { kid: string; key: KeyLike | Uint8Array } | undefined;
const signingKey = async (creds: ChatPlatformCredentials) => {
  if (!cachedKey || cachedKey.kid !== creds.privateJwk.kid) {
    cachedKey = { kid: creds.privateJwk.kid, key: await importJWK(creds.privateJwk, 'ES256') };
  }
  return cachedKey.key;
};

const signDetached = async (creds: ChatPlatformCredentials, payload: string) => {
  const jws = await new FlattenedSign(Buffer.from(payload, 'utf8'))
    .setProtectedHeader({ alg: 'ES256', kid: creds.privateJwk.kid, b64: false, crit: ['b64'] })
    .sign(await signingKey(creds));
  return `${jws.protected}..${jws.signature}`;
};

// Stable UUID so repeating the same logical action replays the stored UCP response.
const IDEMPOTENCY_NAMESPACE = '6f1d0c52-8b43-4d54-9c0e-3b2f8f5a7c11';
export const idempotencyKeyFor = (name: string) => {
  const hash = crypto.createHash('sha1').update(IDEMPOTENCY_NAMESPACE).update(name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export const ucpRequest = async (
  method: 'GET' | 'POST' | 'PUT',
  urlPath: string,
  body?: unknown,
  idempotencyKey?: string
): Promise<any> => {
  const creds = loadChatCredentials();
  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'UCP-Agent': `profile="${creds.profile}"`,
    'Request-Id': crypto.randomUUID(),
    'X-API-Key': creds.apiKey,
    Accept: 'application/json',
    'Request-Signature': await signDetached(creds, bodyStr),
  };
  if (method !== 'GET') headers['Idempotency-Key'] = idempotencyKey || crypto.randomUUID();
  if (bodyStr) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/ucp/v1${urlPath}`, { method, headers, body: bodyStr || undefined });
  } catch (err) {
    throw new ChatUcpError(502, 'ucp_unreachable', 'The checkout service is unreachable.');
  }
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const messages: any[] = json?.messages ?? [];
    const first = messages.find(m => m.type === 'error') ?? messages[0];
    throw new ChatUcpError(res.status, first?.code ?? 'ucp_error', first?.content ?? `Checkout service error (${res.status}).`, messages);
  }
  return json;
};
