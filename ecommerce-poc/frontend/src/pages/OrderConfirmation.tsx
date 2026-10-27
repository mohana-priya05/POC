import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { orderService } from '../services';

const OrderConfirmation: React.FC = () => {
  const { orderId } = useParams<{ orderId: string }>();
  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchOrder = async () => {
      if (!orderId) return;
      try {
        const res = await orderService.getOrderById(orderId);
        setOrder(res.data.data);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchOrder();
  }, [orderId]);

  const formatPrice = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

  if (loading) return <div className="text-center py-12">Loading...</div>;
  if (!order) return <div className="text-center py-12">Order not found</div>;

  return (
    <div className="max-w-2xl mx-auto py-12">
      <div className="text-center mb-8">
        <div className="text-green-600 text-6xl mb-4">✓</div>
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Order Confirmed!</h1>
        <p className="text-gray-600">Thank you for your purchase.</p>
      </div>
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-bold mb-4">Order Details</h2>
        <p className="mb-2"><strong>Order Number:</strong> {order.orderNumber}</p>
        <p className="mb-2"><strong>Status:</strong> <span className="text-green-600 font-semibold">{order.status}</span></p>
        <p className="mb-4"><strong>Customer:</strong> {order.customerName} ({order.customerEmail})</p>
        <div className="border-t pt-4">
          <h3 className="font-semibold mb-2">Items</h3>
          {order.orderItems?.map((item: any) => (
            <div key={item.id} className="flex justify-between mb-2 text-sm">
              <span>{item.product?.name} x {item.quantity}</span>
              <span>{formatPrice(item.subtotalPaise)}</span>
            </div>
          ))}
          <div className="border-t pt-2 mt-2 flex justify-between font-bold">
            <span>Total</span>
            <span>{formatPrice(order.totalPaise)}</span>
          </div>
        </div>
      </div>
      <div className="text-center space-x-4">
        <Link to={`/order/${orderId}`} className="text-blue-600 hover:underline">View Full Order Details</Link>
        <Link to="/" className="text-blue-600 hover:underline">Continue Shopping</Link>
      </div>
    </div>
  );
};

export default OrderConfirmation;
