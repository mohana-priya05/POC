/**
 * Manual signed call, e.g.
 *   npm run ucp:call -- GET /checkout-sessions/chk_123
 *   npm run ucp:call -- POST /checkout-sessions "{\"line_items\":[{\"item\":{\"id\":\"<product-id>\"},\"quantity\":1}]}"
 * The body may also be read from a file: ... POST /checkout-sessions @body.json (avoids shell quoting).
 * Add --curl to print the equivalent curl command (with a freshly signed header) instead.
 */
import fs from 'fs';
import { buildHeaders, call, BASE_URL } from './ucpClient';

(async () => {
  const args = process.argv.slice(2).filter(a => a !== '--curl');
  const [method, urlPath, bodyArg = ''] = args;
  const bodyStr = bodyArg.startsWith('@') ? fs.readFileSync(bodyArg.slice(1), 'utf8').trim() : bodyArg;
  if (!method || !urlPath) {
    console.error('usage: ucp-call <METHOD> <path> [json-body] [--curl]');
    process.exit(2);
  }
  if (process.argv.includes('--curl')) {
    const headers = await buildHeaders(method, bodyStr);
    const h = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v.replace(/"/g, '\\"')}"`).join(' ');
    console.log(`curl -i -X ${method} ${h}${bodyStr ? ` --data-binary '${bodyStr}'` : ''} "${BASE_URL}/ucp/v1${urlPath}"`);
    return;
  }
  const res = await call(method, urlPath, undefined, { rawBody: bodyStr });
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(res.body, null, 2));
})();
