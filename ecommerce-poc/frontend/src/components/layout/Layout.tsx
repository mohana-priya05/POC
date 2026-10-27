import React from 'react';
import { Link } from 'react-router-dom';
import { useCart } from '../../hooks/useCart';

const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { getItemCount } = useCart();

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <Link to="/" className="text-xl font-bold text-blue-600">ShopPOC</Link>
            <div className="flex items-center space-x-6">
              <Link to="/" className="text-gray-700 hover:text-blue-600">Products</Link>
              <Link to="/cart" className="relative text-gray-700 hover:text-blue-600">
                Cart
                {getItemCount() > 0 && (
                  <span className="absolute -top-2 -right-4 bg-blue-600 text-white text-xs rounded-full px-2 py-0.5">
                    {getItemCount()}
                  </span>
                )}
              </Link>
            </div>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-4 p-2 bg-yellow-100 border border-yellow-400 text-yellow-800 rounded text-sm text-center">
          ⚠️ Running in Razorpay Test Mode
        </div>
        {children}
      </main>
    </div>
  );
};

export default Layout;
