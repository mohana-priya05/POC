import { Request, Response } from 'express';
import prisma from '../utils/prisma';
import { razorpay } from '../utils/razorpay';
import crypto from 'crypto';
import { markOrderPaid } from '../services/orderService';

export const createRazorpayOrder = async (req: Request, res: Response) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId is required' });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { payment: true },
    });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: 'Order is not in pending state' });
    }

    const receipt = order.orderNumber;
    const amount = order.totalPaise;

    const razorpayOrder = await razorpay.orders.create({
      amount: amount,
      currency: 'INR',
      receipt: receipt,
      payment_capture: true,
    });

    await prisma.payment.update({
      where: { orderId: order.id },
      data: {
        razorpayOrderId: razorpayOrder.id,
        status: 'ATTEMPTED',
        raw: razorpayOrder as any,
      },
    });

    res.json({
      success: true,
      data: {
        razorpayOrderId: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        keyId: process.env.RAZORPAY_KEY_ID,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to create Razorpay order' });
  }
};

const hmacHex = (secret: string, data: string | Buffer) =>
  crypto.createHmac('sha256', secret).update(data).digest('hex');

const safeEqualHex = (a: string, b: string) => {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

export const verifyPayment = async (req: Request, res: Response) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !orderId) {
      return res.status(400).json({ success: false, message: 'Missing payment details' });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
    const generatedSignature = hmacHex(keySecret, razorpay_order_id + '|' + razorpay_payment_id);

    // A bad signature proves nothing about the real payment, so it must not change order state.
    if (!safeEqualHex(generatedSignature, String(razorpay_signature))) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    const payment = await prisma.payment.findUnique({ where: { orderId }, include: { order: true } });
    if (!payment || !payment.order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    // The Razorpay order must be the one created for THIS order (blocks paying a cheap order
    // and replaying its signature against an expensive one).
    if (payment.razorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({ success: false, message: 'Payment does not belong to this order' });
    }

    // Server-side confirmation with Razorpay: status, amount, currency and order link.
    let rzpPayment: any;
    try {
      rzpPayment = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (err) {
      console.error('Razorpay payment fetch failed', err);
      return res.status(502).json({ success: false, message: 'Unable to confirm payment status with Razorpay' });
    }
    if (
      rzpPayment.order_id !== razorpay_order_id ||
      Number(rzpPayment.amount) !== payment.order.totalPaise ||
      rzpPayment.currency !== 'INR'
    ) {
      return res.status(400).json({ success: false, message: 'Payment details do not match the order' });
    }
    if (rzpPayment.status === 'failed') {
      await prisma.payment.updateMany({
        where: { orderId, status: { not: 'PAID' } },
        data: { status: 'FAILED' },
      });
      return res.status(400).json({ success: false, message: 'Payment failed' });
    }
    if (rzpPayment.status !== 'captured') {
      return res.status(409).json({ success: false, message: 'Payment is not captured yet' });
    }

    const result = await prisma.$transaction(tx =>
      markOrderPaid(tx, orderId, {
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
      })
    );

    res.json({ success: true, data: result.order, alreadyPaid: result.alreadyPaid });
  } catch (err: any) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message || 'Payment verification failed' });
  }
};

export const webhook = async (req: Request, res: Response) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    if (!webhookSecret) {
      return res.status(503).json({ success: false, message: 'Webhook secret is not configured' });
    }

    const signature = req.headers['x-razorpay-signature'];
    const rawBody: string | undefined = (req as any).rawBody;
    if (typeof signature !== 'string' || !rawBody) {
      return res.status(400).json({ success: false, message: 'Missing webhook signature' });
    }
    if (!safeEqualHex(hmacHex(webhookSecret, rawBody), signature)) {
      return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }

    const event = req.body;
    const paymentEntity = event?.payload?.payment?.entity;
    const razorpayOrderId: string | undefined = paymentEntity?.order_id;
    const razorpayPaymentId: string | undefined = paymentEntity?.id;

    if (!razorpayOrderId || !razorpayPaymentId) {
      return res.json({ success: true, ignored: true });
    }

    const payment = await prisma.payment.findFirst({
      where: { razorpayOrderId },
      include: { order: true },
    });
    if (!payment) {
      return res.json({ success: true, ignored: true });
    }

    if (event.event === 'payment.failed') {
      await prisma.payment.updateMany({
        where: { id: payment.id, status: { not: 'PAID' } },
        data: { status: 'FAILED' },
      });
    } else if (event.event === 'payment.captured' || event.event === 'order.paid') {
      if (Number(paymentEntity.amount) !== payment.order.totalPaise) {
        console.error('Webhook amount mismatch for order', payment.orderId);
        return res.json({ success: true, ignored: true });
      }
      try {
        await prisma.$transaction(tx =>
          markOrderPaid(tx, payment.orderId, { razorpayOrderId, razorpayPaymentId, raw: event })
        );
      } catch (e) {
        // Business-rule rejection (e.g. order cancelled, stock gone): acknowledge so Razorpay
        // does not retry forever; the failure is logged for manual review/refund.
        console.error('Webhook could not mark order paid:', (e as Error).message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
};
