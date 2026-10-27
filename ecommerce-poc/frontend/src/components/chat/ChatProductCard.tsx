import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChatProduct } from '../../services/chatService';

const money = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

const ChatProductCard: React.FC<{ product: ChatProduct; onBuy: (product: ChatProduct, quantity: number) => void; disabled?: boolean }> = ({
  product,
  onBuy,
  disabled,
}) => {
  const [qty, setQty] = useState(1);
  const max = Math.min(100, product.stock);

  return (
    <div className="flex gap-3 bg-white border border-gray-200 rounded-xl p-2 shadow-sm">
      <img
        src={product.image || 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=200'}
        alt={product.name}
        className="w-20 h-20 rounded-lg object-cover bg-gray-100 flex-shrink-0"
      />
      <div className="flex-1 min-w-0">
        <Link to={`/product/${product.id}`} className="block text-sm font-semibold text-gray-900 truncate hover:text-blue-600">{product.name}</Link>
        <p className="text-xs text-gray-500 truncate">{product.category}</p>
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-sm font-bold text-blue-600">{money(product.pricePaise)}</span>
          <span className={`text-xs ${product.inStock ? 'text-green-600' : 'text-red-500'}`}>
            {product.inStock ? `${product.stock} in stock` : 'Out of stock'}
          </span>
        </div>
        {product.inStock && (
          <div className="flex items-center gap-2 mt-1.5">
            <div className="flex items-center border rounded-md">
              <button type="button" aria-label="Decrease quantity" className="px-2 text-gray-600 hover:bg-gray-50 disabled:opacity-40" disabled={qty <= 1} onClick={() => setQty(qty - 1)}>−</button>
              <span className="w-6 text-center text-sm">{qty}</span>
              <button type="button" aria-label="Increase quantity" className="px-2 text-gray-600 hover:bg-gray-50 disabled:opacity-40" disabled={qty >= max} onClick={() => setQty(qty + 1)}>+</button>
            </div>
            <button type="button" disabled={disabled} onClick={() => onBuy(product, qty)} className="flex-1 bg-blue-600 text-white text-xs font-semibold py-1.5 rounded-md hover:bg-blue-700 disabled:bg-gray-400 transition-colors">
              Buy now
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatProductCard;
