import request from 'supertest';
import app from '../src/app';
import prisma from '../src/utils/prisma';

jest.mock('../src/utils/prisma', () => {
  const mPrisma: any = {
    product: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    category: {
      findMany: jest.fn(),
    },
    order: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    orderItem: {
      create: jest.fn(),
    },
    payment: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
    },
  };
  mPrisma.$transaction =jest.fn((cb: any) => cb(mPrisma));
  return { __esModule: true, default: mPrisma };
});

jest.mock('../src/utils/razorpay', () => ({ razorpay: { orders: { create: jest.fn() }, payments: { fetch: jest.fn() } } }));

describe('Product API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/products returns products list', async () => {
    (prisma.product.findMany as jest.Mock).mockResolvedValue([{ id: '1', name: 'Test', pricePaise: 1000, active: true }]);
    (prisma.product.count as jest.Mock).mockResolvedValue(1);
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /api/products/:id returns 404 for invalid product', async () => {
    (prisma.product.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get('/api/products/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/products/search returns results', async () => {
    (prisma.product.findMany as jest.Mock).mockResolvedValue([{ id: '1', name: 'Shirt' }]);
    const res = await request(app).get('/api/products/search?q=shirt');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/categories returns categories', async () => {
    (prisma.category.findMany as jest.Mock).mockResolvedValue([{ id: '1', name: 'Men', _count: { products: 5 } }]);
    const res = await request(app).get('/api/products/categories');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
