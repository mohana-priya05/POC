import { Request, Response } from 'express';
import prisma from '../utils/prisma';
import { createPendingOrder } from '../services/orderService';

export const checkout = async (req: Request, res: Response) => {
  try {
    const { customerName, customerEmail, customerPhone, deliveryAddress, items } = req.body;
    
    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Cart is empty' });
    }

    // Fetch products and validate
    const productIds = items.map((i: any) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, active: true },
    });

    if (products.length !== productIds.length) {
      return res.status(400).json({ success: false, message: 'One or more products are invalid or unavailable' });
    }

    // Build order lines with server-calculated prices
    const lines: { productId: string; quantity: number; pricePaise: number }[] = [];

    for (const item of items) {
      const product = products.find(p => p.id === item.productId);
      if (!product) {
        return res.status(400).json({ success: false, message: 'Product not found' });
      }
      if (product.stock < item.quantity) {
        return res.status(400).json({ success: false, message: `Insufficient stock for ${product.name}` });
      }
      lines.push({ productId: product.id, quantity: parseInt(item.quantity), pricePaise: product.pricePaise });
    }

    const order = await prisma.$transaction(tx =>
      createPendingOrder(tx, { customerName, customerEmail, customerPhone, deliveryAddress, lines })
    );

    res.status(201).json({
      success: true,
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        totalPaise: order.totalPaise,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Checkout failed' });
  }
};

export const getOrderById = async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        orderItems: {
          include: { product: true },
        },
        payment: true,
      },
    });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    res.json({ success: true, data: order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch order' });
  }
};
