import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { orderService, paymentService } from '../services';
import { useCart } from '../hooks/useCart';

const Payment: React.FC = () => {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const { clearCart } = useCart();
  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    const fetchOrder = async () => {
      try {
        if (!orderId) return;
        const res = await orderService.getOrderById(orderId);
        setOrder(res.data.data);
      } catch (err) {
        console.error(err);
        alert('Order not found');
        navigate('/');
      } finally {
        setLoading(false);
      }
    };
    fetchOrder();
  }, [orderId]);

  const handlePayment = async () => {
    if (!orderId || !order) return;
    setProcessing(true);
    try {
      const res = await paymentService.createOrder(orderId);
      const { razorpayOrderId, amount, keyId } = res.data.data;

      const options = {
        key: keyId,
        amount: amount,
        currency: 'INR',
        name: 'ShopPOC',
        description: `Order ${order.orderNumber}`,
        order_id: razorpayOrderId,
        handler: async function (response: any) {
          try {
            const verifyRes = await paymentService.verifyPayment({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
              orderId: orderId,
            });
            if (verifyRes.data.success) {
              clearCart();
              navigate(`/order-confirmation/${orderId}`);
            } else {
              navigate(`/payment-result/${orderId}?status=failed`);
            }
          } catch (err) {
            navigate(`/payment-result/${orderId}?status=failed`);
          }
        },
        prefill: {
          name: order.customerName,
          email: order.customerEmail,
          contact: order.customerPhone,
        },
        theme: {
          color: '#2563eb',
        },
        modal: {
          ondismiss: function () {
            setProcessing(false);
            navigate(`/payment-result/${orderId}?status=cancelled`);
          },
        },
      };

      const rzp = new (window as any).Razorpay(options);
      rzp.on('payment.failed', function () {
        navigate(`/payment-result/${orderId}?status=failed`);
      });
      rzp.open();
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to initiate payment');
      setProcessing(false);
    }
  };

  const formatPrice = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

  if (loading) return <div className="text-center py-12">Loading...</div>;
  if (!order) return <div className="text-center py-12">Order not found</div>;

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Payment</h1>
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-bold mb-4">Order Summary</h2>
        <p className="text-sm text-gray-600 mb-2">Order Number: <span className="font-semibold">{order.orderNumber}</span></p>
        <div className="space-y-2 mb-4">
          {order.orderItems?.map((item: any) => (
            <div key={item.id} className="flex justify-between text-sm">
              <span>{item.product?.name} x {item.quantity}</span>
              <span>{formatPrice(item.subtotalPaise)}</span>
            </div>
          ))}
        </div>
        <div className="border-t pt-4 flex justify-between text-lg font-bold">
          <span>Total Amount</span>
          <span>{formatPrice(order.totalPaise)}</span>
        </div>
      </div>
      <button
        onClick={handlePayment}
        disabled={processing || order.status !== 'PENDING'}
        className="w-full bg-blue-600 text-white py-3 px-6 rounded-lg hover:bg-blue-700 disabled:bg-gray-400 transition-colors font-semibold">
        {processing ? 'Processing...' : order.status === 'PENDING' ? 'Pay with Razorpay' : `Order ${order.status}` }
      </button>
      <p className="text-center text-sm text-gray-600 mt-4">You will be redirected to Razorpay Checkout (Test Mode)</p>
    </div>
  );
};

export default Payment;
