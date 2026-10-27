import path from 'path';

// Release of the UCP specification this implementation targets (git tag v2026-01-23,
// https://ucp.dev/2026-01-23/). The schemas shipped in that release declare their own
// version as 2026-01-11 (the date of the last breaking change), and that is the string
// payloads must carry, so both values are kept explicit here.
export const UCP_SPEC_RELEASE = '2026-01-23';
export const UCP_VERSION = '2026-01-11';

export const CHECKOUT_CAPABILITY = 'dev.ucp.shopping.checkout';
export const SHOPPING_SERVICE = 'dev.ucp.shopping';

export const SPEC_URLS = {
  overview: `https://ucp.dev/${UCP_SPEC_RELEASE}/specification/overview`,
  checkout: `https://ucp.dev/${UCP_SPEC_RELEASE}/specification/checkout`,
  checkoutSchema: 'https://ucp.dev/schemas/shopping/checkout.json',
  restSchema: 'https://ucp.dev/services/shopping/rest.openapi.json',
};

// Read lazily: .env is loaded after module imports are evaluated.
export const ucpConfig = () => {
  const port = process.env.PORT || 5000;
  return {
    baseUrl: (process.env.UCP_PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    frontendUrl: (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, ''),
    platformsFile: process.env.UCP_PLATFORMS_FILE || path.resolve(process.cwd(), 'ucp-platforms.json'),
    platformsJson: process.env.UCP_PLATFORMS_JSON,
    sessionTtlMs: 6 * 60 * 60 * 1000, // spec default: 6 hours
    rateLimitPerMinute: Number(process.env.UCP_RATE_LIMIT_PER_MIN || 120),
    termsUrl: process.env.UCP_TERMS_URL,
    privacyUrl: process.env.UCP_PRIVACY_URL,
  };
};

export const restEndpoint = () => `${ucpConfig().baseUrl}/ucp/v1`;
