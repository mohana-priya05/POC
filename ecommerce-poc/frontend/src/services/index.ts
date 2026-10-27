import api from './api';

export const productService = {
  getProducts: (params?: any) => api.get('/api/products', { params }),
  getProductById: (id: string) => api.get(`/api/products/${id}`),
  searchProducts: (q: string) => api.get('/api/products/search', { params: { q } }),
  getCategories: () => api.get('/api/products/categories'),
};

export const orderService = {
  checkout: (data: any) => api.post('/api/checkout', data),
  getOrderById: (orderId: string) => api.get(`/api/orders/${orderId}`),
};

export const paymentService = {
  createOrder: (orderId: string) => api.post('/api/payments/create-order', { orderId }),
  verifyPayment: (data: any) => api.post('/api/payments/verify', data),
};
