/**
 * Registers a local TEST platform with this business:
 *  - generates an ES256 signing key pair and an API key
 *  - writes ucp-platforms.json (public key + API-key hash only; read by the server)
 *  - writes .ucp-test-platform/credentials.json (private key + API key; used by the client scripts)
 * Both files are git-ignored. Re-run with --force to rotate.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exportJWK, generateKeyPair } from 'jose';

const root = path.resolve(__dirname, '..');
const platformsFile = path.join(root, 'ucp-platforms.json');
const credDir = path.join(root, '.ucp-test-platform');
const credFile = path.join(credDir, 'credentials.json');

export const TEST_PROFILE = 'https://agent.local.test/profile';

(async () => {
  if ((fs.existsSync(platformsFile) || fs.existsSync(credFile)) && !process.argv.includes('--force')) {
    console.log('UCP test platform already registered. Use --force to rotate keys.');
    return;
  }
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const kid = `test-platform-${new Date().getFullYear()}`;
  const pub = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const priv = { ...(await exportJWK(privateKey)), kid, alg: 'ES256', use: 'sig' };
  const apiKey = `ucp_test_${crypto.randomBytes(24).toString('hex')}`;

  fs.writeFileSync(
    platformsFile,
    JSON.stringify(
      {
        platforms: [
          {
            name: 'local-test-agent',
            profile: TEST_PROFILE,
            api_key_sha256: crypto.createHash('sha256').update(apiKey).digest('hex'),
            signing_keys: [pub],
          },
        ],
      },
      null,
      2
    )
  );
  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(credFile, JSON.stringify({ profile: TEST_PROFILE, apiKey, privateJwk: priv }, null, 2));
  console.log('Registered test platform "local-test-agent".');
  console.log(`  server registry : ${path.relative(process.cwd(), platformsFile)} (public key + key hash)`);
  console.log(`  client secrets  : ${path.relative(process.cwd(), credFile)} (private key + API key)`);
  console.log('Restart the backend so it picks up the registry.');
})();
