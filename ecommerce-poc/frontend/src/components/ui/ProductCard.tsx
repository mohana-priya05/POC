import React, { useState } from 'react';
import { Product } from '../../types';
import { Link } from 'react-router-dom';

const ProductCard: React.FC<{ product: Product; onAddToCart?: (p: Product) => void }> = ({ product, onAddToCart }) => {
  const [added, setAdded] = useState(false);

  const handleAdd = () => {
    onAddToCart?.(product);
    setAdded(true);
    setTimeout(() => setAdded(false), 2000);
  };

  const formatPrice = (paise: number) => {
    return `₹${(paise / 100).toFixed(2)}`;
  };

  return (
    <div className="bg-white rounded-lg shadow-md overflow-hidden hover:shadow-lg transition-shadow">
      <Link to={`/product/${product.id}`}>
        <img 
          src={product.images?.[0] || 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=400'} 
          alt={product.name}
          className="w-full h-48 object-cover"
        />
      </Link>
      <div className="p-4">
        <Link to={`/product/${product.id}`}>
          <h3 className="text-lg font-semibold text-gray-900 mb-1 hover:text-blue-600">{product.name}</h3>
        </Link>
        <p className="text-sm text-gray-600 mb-2 line-clamp-2">{product.description}</p>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xl font-bold text-blue-600">{formatPrice(product.pricePaise)}</span>
          <span className="text-xs text-gray-500">{product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}</span>
        </div>
        {onAddToCart && (
          <button
            type="button"
            onClick={handleAdd}
            disabled={product.stock === 0}
            className={`w-full text-white py-2 px-4 rounded disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors ${added ? 'bg-green-600' : 'bg-blue-600 hover:bg-blue-700'}`}
          >
            {product.stock === 0 ? 'Out of Stock' : added ? '✓ Added to Cart' : 'Add to Cart'}
          </button>
        )}
        {added && (
          <Link to="/cart" className="block text-center text-sm text-blue-600 hover:underline mt-2">View Cart →</Link>
        )}
      </div>
    </div>
  );
};

export default ProductCard;
