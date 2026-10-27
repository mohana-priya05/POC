import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { paymentService } from '../../services';
import { BuyerInput, chatService, CheckoutView, ChatProduct, errorMessage } from '../../services/chatService';

type Step = 'loading' | 'details' | 'review' | 'pay' | 'done' | 'canceled' | 'error';

const money = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';
const primaryBtn = 'w-full bg-blue-600 text-white py-2 rounded-md text-sm font-semibold hover:bg-blue-700 disabled:bg-gray-400 transition-colors';

interface Props {
  product: ChatProduct;
  quantity: number;
}

/**
 * One checkout, driven step by step by the shopper. Every call goes through /api/chat/checkout,
 * which talks to the signed UCP checkout API. The card never decides a price, stock level or
 * payment outcome: it renders what the backend returns.
 */
const CheckoutCard: React.FC<Props> = ({ product, quantity }) => {
  const [step, setStep] = useState<Step>('loading');
  const [view, setView] = useState<CheckoutView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<BuyerInput>({ name: '', email: '', phone: '' });
  const started = useRef(false);
  const requestId = useRef(crypto.randomUUID());

  // "missing" = buyer fields the shopper has not filled in yet. The form asks for those, so they
  // are neither shown nor allowed to block Continue; real problems (stock, invalid items) are.
  const problems = view?.messages.filter(m => m.type === 'error' && m.code !== 'missing') ?? [];

  const start = async () => {
    setStep('loading');
    setError('');
    try {
      const v = await chatService.startCheckout(product.id, quantity, requestId.current);
      setView(v);
      setStep('details');
    } catch (err) {
      setError(errorMessage(err, 'Could not start checkout.'));
      setStep('error');
    }
  };

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice; one session only
    started.current = true;
    start();
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const changeQuantity = (next: number) =>
    run(async () => {
      if (!view) return;
      setView(await chatService.updateCheckout(view.id, { quantity: next }));
    });

  const submitDetails = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (!view) return;
      const v = await chatService.updateCheckout(view.id, { buyer: form });
      setView(v);
      if (v.status === 'ready_for_complete') setStep('review');
      else setError(v.messages.find(m => m.type === 'error')?.content || 'Please check your details.');
    });
  };

  const placeOrder = () =>
    run(async () => {
      if (!view) return;
      const v = await chatService.completeCheckout(view.id);
      setView(v);
      setStep(v.order?.paid ? 'done' : 'pay');
    });

  const cancel = () =>
    run(async () => {
      if (!view) return;
      await chatService.cancelCheckout(view.id);
      setStep('canceled');
    });

  /** Re-reads the checkout from the backend; "paid" is only ever what MySQL says. */
  const confirmFromBackend = async () => {
    for (let i = 0; i < 4; i++) {
      const v = await chatService.getCheckout(view!.id);
      setView(v);
      if (v.order?.paid) return true;
      await new Promise(r => setTimeout(r, 1500));
    }
    return false;
  };

  const pay = () =>
    run(async () => {
      if (!view?.order) return;
      setNotice('');
      const orderId = view.order.id;
      const res = await paymentService.createOrder(orderId);
      const { razorpayOrderId, amount, keyId } = res.data.data;
      if (!(window as any).Razorpay) throw new Error('Razorpay Checkout failed to load. Check your connection and reload.');

      const rzp = new (window as any).Razorpay({
        key: keyId,
        amount,
        currency: 'INR',
        name: 'ShopPOC',
        description: `Order ${view.order.orderNumber}`,
        order_id: razorpayOrderId,
        prefill: { name: form.name, email: form.email, contact: form.phone },
        theme: { color: '#2563eb' },
        handler: async (response: any) => {
          setBusy(true);
          try {
            await paymentService.verifyPayment({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
              orderId,
            });
            if (await confirmFromBackend()) setStep('done');
            else setNotice('Payment is not confirmed yet. If you were charged, it will update shortly; you can also retry below.');
          } catch (err) {
            setNotice(errorMessage(err, 'We could not verify the payment. You have not been marked as paid.'));
          } finally {
            setBusy(false);
          }
        },
        modal: { ondismiss: () => setNotice('Payment was cancelled. Your order is still pending; you can pay again below.') },
      });
      rzp.on('payment.failed', () => setNotice('Payment failed. You can try again below.'));
      rzp.open();
    });

  // ------------------------------------------------------------------ render
  const lines = view?.lineItems ?? [];
  const Summary = () => (
    <div className="space-y-2">
      {lines.map(l => (
        <div key={l.productId} className="flex items-center gap-3">
          <img src={l.image || product.image || ''} alt="" className="w-12 h-12 rounded object-cover bg-gray-100" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">{l.title}</p>
            <p className="text-xs text-gray-500">{money(l.unitPaise)} each</p>
          </div>
          <span className="text-sm font-semibold">{money(l.subtotalPaise)}</span>
        </div>
      ))}
      <div className="flex justify-between border-t pt-2 text-sm font-bold">
        <span>Total</span>
        <span>{money(view?.totalPaise ?? 0)}</span>
      </div>
    </div>
  );

  const Errors = () => (
    <>
      {problems.map(p => (
        <p key={p.code + p.content} className="text-xs text-red-600 bg-red-50 rounded px-2 py-1">{p.content}</p>
      ))}
      {error && <p className="text-xs text-red-600 bg-red-50 rounded px-2 py-1">{error}</p>}
      {notice && <p className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">{notice}</p>}
    </>
  );

  const shell = (title: string, body: React.ReactNode) => (
    <div className="bg-white border border-blue-100 rounded-xl shadow-sm p-3 space-y-3 w-full">
      <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">{title}</p>
      {body}
    </div>
  );

  if (step === 'loading') return shell('Checkout', <p className="text-sm text-gray-500">Preparing your checkout…</p>);

  if (step === 'error')
    return shell(
      'Checkout',
      <>
        <Errors />
        <button type="button" className={primaryBtn} onClick={() => { requestId.current = crypto.randomUUID(); start(); }}>
          Try again
        </button>
      </>
    );

  if (step === 'canceled') return shell('Checkout canceled', <p className="text-sm text-gray-600">No order was created. Ask me for another product any time.</p>);

  if (step === 'done' && view?.order)
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl p-3 space-y-2 w-full">
        <p className="text-sm font-bold text-green-700">✓ Order confirmed. Payment verified.</p>
        <dl className="text-sm text-gray-800 space-y-1">
          <div className="flex justify-between"><dt className="text-gray-500">Order number</dt><dd className="font-semibold">{view.order.orderNumber}</dd></div>
          {view.order.items.map(i => (
            <div key={i.name} className="flex justify-between"><dt className="text-gray-500">{i.name} × {i.quantity}</dt><dd>{money(i.subtotalPaise)}</dd></div>
          ))}
          <div className="flex justify-between border-t border-green-200 pt-1 font-bold"><dt>Total paid</dt><dd>{money(view.order.totalPaise)}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-500">Payment status</dt><dd className="font-semibold">{view.order.paymentStatus}</dd></div>
        </dl>
        <Link to={`/order/${view.order.id}`} className="block text-center text-sm text-blue-600 hover:underline">View order details →</Link>
      </div>
    );

  if (step === 'pay' && view?.order)
    return shell(
      `Order ${view.order.orderNumber} created`,
      <>
        <Summary />
        <p className="text-xs text-gray-500">Your order is reserved as pending. Pay securely with Razorpay (test mode: card 4111 1111 1111 1111).</p>
        <Errors />
        <button type="button" className={primaryBtn} disabled={busy} onClick={pay}>
          {busy ? 'Please wait…' : `Pay ${money(view.order.totalPaise)} with Razorpay`}
        </button>
        <Link to={`/payment/${view.order.id}`} className="block text-center text-xs text-gray-500 hover:underline">Or open the full payment page</Link>
      </>
    );

  if (step === 'review')
    return shell(
      'Review your order',
      <>
        <Summary />
        <p className="text-xs text-gray-600">
          {view?.buyer?.first_name} {view?.buyer?.last_name} · {view?.buyer?.email} · {view?.buyer?.phone_number}
        </p>
        <Errors />
        <button type="button" className={primaryBtn} disabled={busy || problems.length > 0} onClick={placeOrder}>
          {busy ? 'Placing order…' : 'Place order & continue to payment'}
        </button>
        <div className="flex gap-2">
          <button type="button" className="flex-1 text-xs text-gray-600 border rounded-md py-1.5 hover:bg-gray-50" disabled={busy} onClick={() => setStep('details')}>Edit details</button>
          <button type="button" className="flex-1 text-xs text-red-600 border border-red-200 rounded-md py-1.5 hover:bg-red-50" disabled={busy} onClick={cancel}>Cancel</button>
        </div>
      </>
    );

  // details
  const q = lines[0]?.quantity ?? quantity;
  return shell(
    'Checkout',
    <>
      <Summary />
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-700">Quantity</span>
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Decrease quantity" className="w-7 h-7 rounded border hover:bg-gray-50 disabled:opacity-40" disabled={busy || q <= 1} onClick={() => changeQuantity(q - 1)}>−</button>
          <span className="w-6 text-center font-semibold">{q}</span>
          <button type="button" aria-label="Increase quantity" className="w-7 h-7 rounded border hover:bg-gray-50 disabled:opacity-40" disabled={busy || q >= Math.min(100, product.stock)} onClick={() => changeQuantity(q + 1)}>+</button>
        </div>
      </div>
      <form onSubmit={submitDetails} className="space-y-2">
        <input className={inputCls} placeholder="Full name" required minLength={2} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <input className={inputCls} type="email" placeholder="Email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
        <input className={inputCls} type="tel" placeholder="Phone (10-digit mobile or +country code)" required value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
        <Errors />
        <button type="submit" className={primaryBtn} disabled={busy || problems.length > 0}>{busy ? 'Saving…' : 'Continue'}</button>
      </form>
      <button type="button" className="w-full text-xs text-red-600 hover:underline" disabled={busy} onClick={cancel}>Cancel checkout</button>
    </>
  );
};

export default CheckoutCard;
