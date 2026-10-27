import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { orderService } from '../services';

const OrderDetails: React.FC = () => {
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
    <div className="max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Order Details</h1>
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <p className="text-sm text-gray-600">Order Number</p>
            <p className="font-semibold">{order.orderNumber}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Order Status</p>
            <p className="font-semibold">{order.status}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Customer Name</p>
            <p className="font-semibold">{order.customerName}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Email</p>
            <p className="font-semibold">{order.customerEmail}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Phone</p>
            <p className="font-semibold">{order.customerPhone}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Total Amount</p>
            <p className="font-semibold">{formatPrice(order.totalPaise)}</p>
          </div>
        </div>
        <div className="mb-4">
          <p className="text-sm text-gray-600">Delivery Address</p>
          <p className="font-semibold">{order.deliveryAddress}</p>
        </div>
        <div>
          <p className="text-sm text-gray-600 mb-2">Payment Status</p>
          <p className="font-semibold">{order.payment?.status || 'N/A'}</p>
        </div>
      </div>
      <div className="bg-white p-6 rounded-lg shadow-md">
        <h2 className="text-xl font-bold mb-4">Order Items</h2>
        {order.orderItems?.map((item: any) => (
          <div key={item.id} className="flex gap-4 mb-4 pb-4 border-b last:border-b-0">
            <img
              src={item.product?.images?.[0] || 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=100'}
              alt={item.product?.name}
              className="w-16 h-16 object-cover rounded"
            />
            <div className="flex-1">
              <p className="font-semibold">{item.product?.name}</p>
              <p className="text-sm text-gray-600">Qty: {item.quantity} x {formatPrice(item.pricePaise)}</p>
            </div>
            <div className="text-right">
              <p className="font-semibold">{formatPrice(item.subtotalPaise)}</p>
            </div>
 </div>
        ))}
        <div className="text-center mt-6">
          <Link to="/" className="text-blue-600 hover:underline">Back to Home</Link>
        </div>
      </div>
    </div>
  );
};

export default OrderDetails;
