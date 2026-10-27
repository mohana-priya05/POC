import { Request, Response } from 'express';
import { CHECKOUT_CAPABILITY, SHOPPING_SERVICE, SPEC_URLS, UCP_VERSION, restEndpoint } from './config';

// Advertises only what is implemented: the REST binding of the shopping service and the
// checkout capability. No payment handler is advertised: Razorpay is not a UCP payment
// handler, so payment happens on the continue_url hand-off instead. No signing_keys are
// published because this server does not sign anything (no webhooks / order capability).
export const buildProfile = () => ({
  ucp: {
    version: UCP_VERSION,
    services: {
      [SHOPPING_SERVICE]: [
        {
          version: UCP_VERSION,
          spec: SPEC_URLS.overview,
          transport: 'rest',
          endpoint: restEndpoint(),
          schema: SPEC_URLS.restSchema,
        },
      ],
    },
    capabilities: {
      [CHECKOUT_CAPABILITY]: [
        { version: UCP_VERSION, spec: SPEC_URLS.checkout, schema: SPEC_URLS.checkoutSchema },
      ],
    },
    payment_handlers: {},
  },
});

export const discoveryHandler = (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(buildProfile());
};
