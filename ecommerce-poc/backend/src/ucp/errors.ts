import { CHECKOUT_CAPABILITY, UCP_VERSION } from './config';

export type Severity = 'recoverable' | 'requires_buyer_input' | 'requires_buyer_review';

export interface UcpMessage {
  type: 'error' | 'warning' | 'info';
  code?: string;
  content: string;
  severity?: Severity;
  path?: string;
}

export const ucpMeta = () => ({
  version: UCP_VERSION,
  capabilities: { [CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION }] },
  payment_handlers: {},
});

export class UcpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public content: string,
    public severity: Severity = 'recoverable',
    public path?: string
  ) {
    super(content);
  }

  // Optional full message list (e.g. several validation problems at once).
  messages?: UcpMessage[];

  toBody() {
    if (this.messages) return { ucp: ucpMeta(), messages: this.messages };
    const message: UcpMessage = { type: 'error', code: this.code, content: this.content, severity: this.severity };
    if (this.path) message.path = this.path;
    return { ucp: ucpMeta(), messages: [message] };
  }
}
