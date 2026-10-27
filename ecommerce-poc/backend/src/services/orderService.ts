import crypto from 'crypto';
import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export interface PendingOrderInput {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  deliveryAddress: string;
  // pricePaise must come from the products table, never from the client.
  lines: { productId: string; quantity: number; pricePaise: number }[];
}

// Shared by POST /api/checkout and the UCP checkout completion.
export const createPendingOrder = async (tx: Tx, input: PendingOrderInput) => {
  const orderItemsData = input.lines.map(l => ({
    productId: l.productId,
    quantity: l.quantity,
    pricePaise: l.pricePaise,
    subtotalPaise: l.pricePaise * l.quantity,
  }));
  const subtotalPaise = orderItemsData.reduce((sum, i) => sum + i.subtotalPaise, 0);
  const totalPaise = subtotalPaise;
  const orderNumber = `ORD-${Date.now()}-${crypto.randomInt(100000, 999999)}`;

  const newOrder = await tx.order.create({
    data: {
      orderNumber,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      deliveryAddress: input.deliveryAddress,
      subtotalPaise,
      totalPaise,
      status: 'PENDING',
    },
  });

  for (const oi of orderItemsData) {
    await tx.orderItem.create({ data: { orderId: newOrder.id, ...oi } });
  }

  await tx.payment.create({
    data: { orderId: newOrder.id, amountPaise: totalPaise, currency: 'INR', status: 'CREATED', raw: {} },
  });

  return newOrder;
};

export interface PaidDetails {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature?: string;
  raw?: unknown;
}

// Single place where an order becomes PAID, used by the verify endpoint and the webhook.
// The PENDING -> PAID flip is a conditional update, so when verify and webhook race only one
// of them wins and stock is decremented exactly once. Stock is decremented with a guarded
// UPDATE (stock >= qty), so concurrent orders can never drive stock negative.
export const markOrderPaid = async (tx: Tx, orderId: string, details: PaidDetails) => {
  const claimed = await tx.order.updateMany({
    where: { id: orderId, status: 'PENDING' },
    data: { status: 'PAID' },
  });

  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { orderItems: { include: { product: true } }, payment: true },
  });
  if (!order) throw new Error('Order not found');

  if (claimed.count === 0) {
    if (order.status === 'PAID') return { alreadyPaid: true, order };
    throw new Error('Order not in pending state');
  }

  for (const item of order.orderItems) {
    const res = await tx.product.updateMany({
      where: { id: item.productId, stock: { gte: item.quantity } },
      data: { stock: { decrement: item.quantity } },
    });
    if (res.count !== 1) throw new Error('Insufficient stock at verification time');
  }

  await tx.payment.update({
    where: { orderId },
    data: {
      razorpayOrderId: details.razorpayOrderId,
      razorpayPaymentId: details.razorpayPaymentId,
      ...(details.razorpaySignature ? { razorpaySignature: details.razorpaySignature } : {}),
      ...(details.raw ? { raw: details.raw as any } : {}),
      status: 'PAID',
    },
  });

  const paidOrder = await tx.order.findUnique({
    where: { id: orderId },
    include: { orderItems: { include: { product: true } }, payment: true },
  });
  return { alreadyPaid: false, order: paidOrder! };
};
