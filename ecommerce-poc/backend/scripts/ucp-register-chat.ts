/**
 * Registers the website chatbot as a UCP platform ("website-chat-assistant").
 *  - adds/replaces its entry in ucp-platforms.json (public key + API-key hash only; other platforms untouched)
 *  - writes .ucp-test-platform/chat-credentials.json (private key + API key; read only by the backend)
 * Both are git-ignored. Re-run with --force to rotate the chatbot's keys.
 * For production, put the same values in CHAT_UCP_PROFILE / CHAT_UCP_API_KEY / CHAT_UCP_PRIVATE_JWK instead.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exportJWK, generateKeyPair } from 'jose';

const root = path.resolve(__dirname, '..');
const platformsFile = path.join(root, 'ucp-platforms.json');
const credDir = path.join(root, '.ucp-test-platform');
const credFile = path.join(credDir, 'chat-credentials.json');

const NAME = 'website-chat-assistant';
const PROFILE = 'https://shop.local/website-chat-assistant/profile';

(async () => {
  if (fs.existsSync(credFile) && !process.argv.includes('--force')) {
    console.log('Chatbot platform already registered. Use --force to rotate its keys.');
    return;
  }
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const kid = `website-chat-${new Date().getFullYear()}`;
  const pub = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const priv = { ...(await exportJWK(privateKey)), kid, alg: 'ES256', use: 'sig' };
  const apiKey = `ucp_chat_${crypto.randomBytes(24).toString('hex')}`;

  const registry = fs.existsSync(platformsFile) ? JSON.parse(fs.readFileSync(platformsFile, 'utf8')) : { platforms: [] };
  registry.platforms = (registry.platforms ?? []).filter((p: any) => p.profile !== PROFILE);
  registry.platforms.push({
    name: NAME,
    profile: PROFILE,
    api_key_sha256: crypto.createHash('sha256').update(apiKey).digest('hex'),
    signing_keys: [pub],
  });
  fs.writeFileSync(platformsFile, JSON.stringify(registry, null, 2));

  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(credFile, JSON.stringify({ profile: PROFILE, apiKey, privateJwk: priv }, null, 2));
  console.log(`Registered platform "${NAME}".`);
  console.log(`  registry : ${path.relative(process.cwd(), platformsFile)} (public key + key hash; other platforms kept)`);
  console.log(`  secrets  : ${path.relative(process.cwd(), credFile)}`);
  console.log('The registry is re-read on every request; no restart is needed for it.');
})();
