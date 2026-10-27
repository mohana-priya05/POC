import request from 'supertest';
import app from '../src/app';
import prisma from '../src/utils/prisma';
import crypto from 'crypto';

jest.mock('../src/utils/prisma', () => {
  const mPrisma: any = {
    product: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    order: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    orderItem: { create: jest.fn() },
    payment: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
  };
  mPrisma.$transaction =jest.fn((cb: any) => cb(mPrisma));
  return { __esModule: true, default: mPrisma };
});

jest.mock('../src/utils/razorpay', () => ({
  razorpay: {
    orders: {
      create: jest.fn().mockResolvedValue({ id: 'order_123', amount: 1000, currency: 'INR' }),
    },
    payments: {
      fetch: jest.fn().mockResolvedValue({ id: 'pay_123', order_id: 'order_123', amount: 1000, currency: 'INR', status: 'captured' }),
    },
  },
}));

describe('Checkout and Payment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAZORPAY_KEY_SECRET = 'test_secret';
  });

  it('POST /api/checkout validates and returns 400 for empty items', async () => {
    const res = await request(app).post('/api/checkout').send({
      customerName: 'Test',
      customerEmail: 'test@test.com',
      customerPhone: '1234567890',
      deliveryAddress: '123 Street',
      items: [],
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/payments/verify fails with invalid signature', async () => {
    (prisma.payment.updateMany as jest.Mock).mockResolvedValue({});
    (prisma.order.update as jest.Mock).mockResolvedValue({});
    const res = await request(app).post('/api/payments/verify').send({
      razorpay_order_id: 'order_123',
      razorpay_payment_id: 'pay_123',
      razorpay_signature: 'bad_signature',
      orderId: 'order-uuid',
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    // a forged signature must not alter order or payment state
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it('POST /api/payments/verify succeeds with valid signature', async () => {
    const secret = 'test_secret';
    const orderId = 'o1';
    const razorpay_order_id = 'order_123';
    const razorpay_payment_id = 'pay_123';
    const sig = crypto.createHmac('sha256', secret).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue({
      orderId,
      razorpayOrderId: razorpay_order_id,
      order: { id: orderId, totalPaise: 1000 },
    });
    (prisma.order.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    const orderRow = {
      id: orderId,
      status: 'PENDING',
      orderItems: [{ productId: 'p1', quantity: 1 }],
      payment: { orderId },
    };
    (prisma.order.findUnique as jest.Mock).mockResolvedValue(orderRow);
    (prisma.product.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.payment.update as jest.Mock).mockResolvedValue({});

    const res = await request(app).post('/api/payments/verify').send({
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature: sig,
      orderId,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
