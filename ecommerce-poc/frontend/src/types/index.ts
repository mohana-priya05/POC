export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string;
  pricePaise: number;
  images: string[];
  stock: number;
  active: boolean;
  categoryId: string;
  category?: { id: string; name: string; slug: string };
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  _count?: { products: number };
}

export interface CartItem {
  productId: string;
  product: Product;
  quantity: number;
}

export interface CheckoutForm {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  deliveryAddress: string;
}
