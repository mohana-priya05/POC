import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { CartItem } from '../types';

const CART_KEY = 'ecommerce_cart';

const useCartState = () => {
  const [cart, setCart] = useState<CartItem[]>(() => {
    try {
      const saved = localStorage.getItem(CART_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  }, [cart]);

  const addToCart = (product: any, quantity = 1): boolean => {
    const existing = cart.find(item => item.productId === product.id);
    const newQty = (existing?.quantity ?? 0) + quantity;
    if (product.stock < newQty) {
      alert('Not enough stock');
      return false;
    }
    setCart(prev =>
      prev.some(item => item.productId === product.id)
        ? prev.map(item =>
            item.productId === product.id ? { ...item, quantity: newQty } : item
          )
        : [...prev, { productId: product.id, product, quantity }]
    );
    return true;
  };

  const removeFromCart = (productId: string) => {
    setCart(prev => prev.filter(item => item.productId !== productId));
  };

  const updateQuantity = (productId: string, quantity: number) => {
    if (quantity <= 0) {
      removeFromCart(productId);
      return;
    }
    const item = cart.find(i => i.productId === productId);
    if (item && item.product.stock < quantity) {
      alert('Not enough stock');
      return;
    }
    setCart(prev =>
      prev.map(i => (i.productId === productId ? { ...i, quantity } : i))
    );
  };

  const clearCart = () => {
    setCart([]);
  };

  const getTotal = () => {
    return cart.reduce((sum, item) => sum + item.product.pricePaise * item.quantity, 0);
  };

  const getItemCount = () => {
    return cart.reduce((sum, item) => sum + item.quantity, 0);
  };

  return {
    cart,
    addToCart,
    updateQuantity,
    removeFromCart,
    clearCart,
    getTotal,
    getItemCount,
  };
};

type CartContextValue = ReturnType<typeof useCartState>;

const CartContext = createContext<CartContextValue | null>(null);

export const CartProvider = ({ children }: { children: ReactNode }) => {
  const value = useCartState();
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
};

export const useCart = () => {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within a CartProvider');
  return ctx;
};
