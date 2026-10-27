import api from './api';

export interface ChatProduct {
  id: string;
  name: string;
  description: string;
  pricePaise: number;
  image: string | null;
  stock: number;
  inStock: boolean;
  category: string | null;
}

export interface ChatMessageResult {
  reply: string;
  products: ChatProduct[];
  aiAvailable: boolean;
}

export interface CheckoutView {
  id: string;
  status: string;
  lineItems: { productId: string; title: string; image: string | null; unitPaise: number; quantity: number; subtotalPaise: number }[];
  totalPaise: number;
  buyer: { first_name?: string; last_name?: string; email?: string; phone_number?: string } | null;
  messages: { type: string; code: string; content: string }[];
  order: {
    id: string;
    orderNumber: string;
    status: string;
    paymentStatus: string | null;
    totalPaise: number;
    paid: boolean;
    items: { name: string; quantity: number; subtotalPaise: number }[];
  } | null;
}

export interface BuyerInput {
  name: string;
  email: string;
  phone: string;
}

export const chatService = {
  send: (message: string, history: { role: 'user' | 'assistant'; text: string }[]) =>
    api.post('/api/chat/message', { message, history }).then(r => r.data.data as ChatMessageResult),
  startCheckout: (productId: string, quantity: number, requestId: string) =>
    api.post('/api/chat/checkout', { productId, quantity, requestId }).then(r => r.data.data as CheckoutView),
  getCheckout: (id: string) => api.get(`/api/chat/checkout/${id}`).then(r => r.data.data as CheckoutView),
  updateCheckout: (id: string, patch: { quantity?: number; buyer?: BuyerInput }) =>
    api.patch(`/api/chat/checkout/${id}`, patch).then(r => r.data.data as CheckoutView),
  completeCheckout: (id: string) => api.post(`/api/chat/checkout/${id}/complete`).then(r => r.data.data as CheckoutView),
  cancelCheckout: (id: string) => api.post(`/api/chat/checkout/${id}/cancel`).then(r => r.data.data as CheckoutView),
};

export const errorMessage = (err: any, fallback = 'Something went wrong. Please try again.') =>
  err?.response?.data?.message || fallback;
