import React, { useEffect, useRef, useState } from 'react';
import { chatService, ChatProduct, errorMessage } from '../../services/chatService';
import ChatProductCard from './ChatProductCard';
import CheckoutCard from './CheckoutCard';

type Item =
  | { id: number; kind: 'text'; role: 'user' | 'assistant'; text: string }
  | { id: number; kind: 'products'; products: ChatProduct[] }
  | { id: number; kind: 'checkout'; product: ChatProduct; quantity: number };

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

const SUGGESTIONS = ['Show me a Canvas Backpack', 'T-shirt under ₹1,000', 'What is in Accessories?'];

const ChatWidget: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([
    { id: 0, kind: 'text', role: 'assistant', text: "Hi! I'm the ShopPOC assistant. Tell me what you're looking for and I can help you find it and check out right here." },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const nextId = useRef(1);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items, sending, open]);

  const push = (item: DistributiveOmit<Item, 'id'>) => setItems(prev => [...prev, { ...item, id: nextId.current++ } as Item]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || sending) return;
    const history = items
      .filter((i): i is Extract<Item, { kind: 'text' }> => i.kind === 'text')
      .slice(1) // greeting
      .slice(-10)
      .map(i => ({ role: i.role, text: i.text }));
    push({ kind: 'text', role: 'user', text: message });
    setInput('');
    setSending(true);
    try {
      const res = await chatService.send(message, history);
      push({ kind: 'text', role: 'assistant', text: res.reply });
      if (res.products.length) push({ kind: 'products', products: res.products });
    } catch (err) {
      push({ kind: 'text', role: 'assistant', text: errorMessage(err, 'Sorry, I could not reach the store right now. Please try again.') });
    } finally {
      setSending(false);
    }
  };

  const buy = (product: ChatProduct, quantity: number) => push({ kind: 'checkout', product, quantity });

  return (
    <>
      {!open && (
        <button
          type="button"
          aria-label="Open shopping assistant"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-50 w-14 h-14 rounded-full bg-blue-600 text-white shadow-lg hover:bg-blue-700 flex items-center justify-center transition-transform hover:scale-105"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8M8 14h5m-9 6l2.6-2.6A9 9 0 1121 12a9 9 0 01-9 9H4z" />
          </svg>
        </button>
      )}

      {/* Kept mounted while closed so an in-progress checkout is not lost. */}
      <div
        className={`${open ? 'flex' : 'hidden'} fixed z-50 flex-col bg-gray-50 shadow-2xl border border-gray-200
          inset-0 sm:inset-auto sm:bottom-5 sm:right-5 sm:w-[400px] sm:h-[620px] sm:max-h-[calc(100vh-2.5rem)] sm:rounded-2xl overflow-hidden`}
        role="dialog"
        aria-label="Shopping assistant"
      >
        <div className="bg-blue-600 text-white px-4 py-3 flex items-center justify-between">
          <div>
            <p className="font-semibold leading-tight">ShopPOC Assistant</p>
            <p className="text-xs text-blue-100">Powered by Gemini · Razorpay test mode</p>
          </div>
          <button type="button" aria-label="Close assistant" onClick={() => setOpen(false)} className="text-2xl leading-none px-2 hover:text-blue-100">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {items.map(item => {
            if (item.kind === 'text')
              return (
                <div key={item.id} className={`flex ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap ${item.role === 'user' ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-white border border-gray-200 text-gray-800 rounded-bl-sm'}`}>
                    {item.text}
                  </div>
                </div>
              );
            if (item.kind === 'products')
              return (
                <div key={item.id} className="space-y-2">
                  {item.products.map(p => (
                    <ChatProductCard key={p.id} product={p} onBuy={buy} />
                  ))}
                </div>
              );
            return <CheckoutCard key={item.id} product={item.product} quantity={item.quantity} />;
          })}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-white border border-gray-200 rounded-2xl px-3 py-2 text-sm text-gray-400">Thinking…</div>
            </div>
          )}
          {items.length === 1 && (
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map(s => (
                <button key={s} type="button" onClick={() => send(s)} className="text-xs bg-white border border-blue-200 text-blue-700 rounded-full px-3 py-1 hover:bg-blue-50">
                  {s}
                </button>
              ))}
            </div>
          )}
          <div ref={bottom} />
        </div>

        <form
          onSubmit={e => {
            e.preventDefault();
            send(input);
          }}
          className="border-t bg-white p-2 flex gap-2"
        >
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            maxLength={500}
            placeholder="Ask about products…"
            className="flex-1 border border-gray-300 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button type="submit" disabled={sending || !input.trim()} className="bg-blue-600 text-white rounded-full px-4 text-sm font-semibold hover:bg-blue-700 disabled:bg-gray-300">
            Send
          </button>
        </form>
      </div>
    </>
  );
};

export default ChatWidget;
