import fs from 'fs';
import crypto from 'crypto';
import { ucpConfig } from './config';

export interface SigningKey {
  kid: string;
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  alg?: string;
  use?: string;
}

export interface TrustedPlatform {
  name: string;
  profile: string; // value of the UCP-Agent `profile` member
  api_key_sha256: string; // sha256 hex of the X-API-Key issued to this platform
  signing_keys: SigningKey[]; // public JWKs used to verify Request-Signature
}

// Only platforms registered here may call the API. The platform profile is NOT fetched from
// the network on request: fetching an attacker-supplied URL would be an SSRF vector, so
// keys are registered out of band (see scripts/ucp-setup.ts).
export const loadPlatforms = (): TrustedPlatform[] => {
  const cfg = ucpConfig();
  try {
    const raw = cfg.platformsJson ?? (fs.existsSync(cfg.platformsFile) ? fs.readFileSync(cfg.platformsFile, 'utf8') : '');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.platforms) ? parsed.platforms : [];
  } catch (err) {
    console.error('Failed to load UCP platforms registry:', (err as Error).message);
    return [];
  }
};

export const findPlatformByProfile = (profile: string) => loadPlatforms().find(p => p.profile === profile);

export const apiKeyMatches = (platform: TrustedPlatform, apiKey: string) => {
  const given = crypto.createHash('sha256').update(apiKey).digest();
  const expected = Buffer.from(platform.api_key_sha256 || '', 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(given, expected);
};
