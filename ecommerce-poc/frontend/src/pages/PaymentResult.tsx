import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { orderService } from '../services';

const PaymentResult: React.FC = () => {
  const { orderId } = useParams<{ orderId: string }>();
  const [searchParams] = useSearchParams();
  const status = searchParams.get('status');
  const [order, setOrder] = useState<any>(null);

  useEffect(() => {
    const fetchOrder = async () => {
      if (!orderId) return;
      try {
        const res = await orderService.getOrderById(orderId);
        setOrder(res.data.data);
      } catch (err) {
        console.error(err);
      }
    };
    fetchOrder();
  }, [orderId]);

  const isSuccess = order?.status === 'PAID';
  const isFailed = status === 'failed' || order?.status === 'FAILED';
  const isCancelled = status === 'cancelled';

  return (
    <div className="max-w-2xl mx-auto text-center py-12">
      {isSuccess ? (
        <>
          <div className="text-green-600 text-6xl mb-4">✓</div>
          <h1 className="text-3xl font-bold text-gray-900 mb-4">Payment Successful!</h1>
          <p className="text-gray-600 mb-6">Your order has been confirmed.</p>
        </>
      ) : isFailed ? (
        <>
          <div className="text-red-600 text-6xl mb-4">✗</div>
          <h1 className="text-3xl font-bold text-gray-900 mb-4">Payment Failed</h1>
          <p className="text-gray-600 mb-6">There was an issue with your payment. Please try again.</p>
        </>
      ) : isCancelled ? (
        <>
          <div className="text-yellow-600 text-6xl mb-4">⚠</div>
          <h1 className="text-3xl font-bold text-gray-900 mb-4">Payment Cancelled</h1>
          <p className="text-gray-600 mb-6">You cancelled the payment process.</p>
        </>
      ) : (
        <>
          <h1 className="text-3xl font-bold text-gray-900 mb-4">Payment Status</h1>
          <p className="text-gray-600 mb-6">Checking payment status...</p>
        </>
      )}
      {order && (
        <div className="bg-white p-6 rounded-lg shadow-md mb-6 text-left">
          <p className="mb-2"><strong>Order Number:</strong> {order.orderNumber}</p>
          <p className="mb-2"><strong>Status:</strong> {order.status}</p>
          <p className="mb-2"><strong>Total:</strong> ₹{(order.totalPaise / 100).toFixed(2)}</p>
        </div>
      )}
      <div className="space-x-4">
        {orderId && <Link to={`/order/${orderId}`} className="text-blue-600 hover:underline">View Order Details</Link>}
        <Link to="/" className="text-blue-600 hover:underline">Continue Shopping</Link>
      </div>
    </div>
  );
};

export default PaymentResult;
