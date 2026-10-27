# Ecommerce POC - Full Stack E-commerce App with Razorpay Test Mode

Complete, functional e-commerce application built with React + Vite + TypeScript + Tailwind (frontend), Node.js + Express + TypeScript + Prisma + PostgreSQL (backend), integrated with Razorpay Test Mode.

## UCP (Universal Commerce Protocol)

The backend also exposes a UCP checkout API (`/.well-known/ucp`, `/ucp/v1/checkout-sessions`) on top of the existing catalogue, orders and Razorpay flow. See [backend/docs/UCP.md](backend/docs/UCP.md) for the flow, commands, test results and known limitations.

## Features

- **Product Management**: Browse products, search by name/description, filter by category, sort by price, pagination
- **Shopping Cart**: Add/update/remove items, persists in localStorage, stock validation
- **Checkout**: Customer details form, order summary, server-side price validation
- **Payments**: Razorpay Test Mode integration with signature verification
- **Order Management**: Order tracking, confirmation pages, order details

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, React Router, Axios
- **Backend**: Node.js, Express, TypeScript, Prisma ORM
- **Database**: PostgreSQL
- **Payment**: Razorpay Test Mode

## Prerequisites

- Node.js (v18+)
- PostgreSQL database
- Razorpay Test Mode account (get test keys from Razorpay dashboard)

## Setup Instructions

### 1. Clone and Install Dependencies

`ash
# Navigate to project
cd ecommerce-poc

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
`

### 2. Database Setup

`ash
# Navigate to backend
cd backend

# Copy environment file
cp .env.example .env
# Edit .env with your PostgreSQL credentials and Razorpay test keys

# Generate Prisma client
npx prisma generate

# Run migrations
npx prisma migrate dev --name init

# Seed database with sample products (15+ products across 4 categories)
npm run seed
`

### 3. Environment Variables

**Backend (.env):**
`env
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/ecommerce_poc"
PORT=5000
FRONTEND_URL="http://localhost:5173"
RAZORPAY_KEY_ID="your_test_key_id"
RAZORPAY_KEY_SECRET="your_test_key_secret"
RAZORPAY_WEBHOOK_SECRET="your_test_webhook_secret"
NODE_ENV=development
`

**Frontend (.env):**
`env
VITE_API_URL=http://localhost:5000
`

### 4. Run the Application

`ash
# Terminal 1 - Backend
cd backend
npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev
`

- Frontend: http://localhost:5173
- Backend: http://localhost:5000
- API Health: http://localhost:5000/health

## Testing

### Backend Tests

`ash
cd backend
npm test
`

Tests cover: product listing/search, invalid products, checkout validation, payment signature verification (valid/invalid), etc. Razorpay SDK is mocked in tests.

## API Endpoints

### Products
- GET /api/products - List products with filters (q, category, sort, page, limit)
- GET /api/products/:id - Get product details
- GET /api/products/search?q=... - Search products
- GET /api/products/categories - Get all categories

### Orders & Checkout
- POST /api/checkout - Create pending order (validates stock and prices server-side)
- GET /api/orders/:orderId - Get order details

### Payments
- POST /api/payments/create-order - Create Razorpay order for pending order
- POST /api/payments/verify - Verify payment signature and complete order
- POST /api/payments/webhook - Handle Razorpay webhooks (idempotent)

## End-to-End Checkout & Payment Flow

1. **Browse**: User views products on home page
2. **Add to Cart**: Items added to cart (stored in localStorage), stock validated
3. **Checkout**: User fills customer details and delivery address
4. **Order Creation**: Backend validates products/prices/stock from DB, creates PENDING order with OrderItems, creates Payment record
5. **Payment Initiation**: Frontend calls /api/payments/create-order, backend creates Razorpay order with amount in paise
6. **Razorpay Checkout**: Frontend opens Razorpay Checkout with order details
7. **Payment**: User pays using Razorpay test cards/UPI (see Razorpay test docs)
8. **Verification**: Frontend sends payment response to backend /api/payments/verify, backend verifies HMAC SHA-256 signature
9. **Order Completion**: On successful verification, backend decrements stock in transaction, updates Payment to PAID, updates Order to PAID
10. **Confirmation**: User redirected to order confirmation page

## Security Features

- All prices calculated server-side from database (never trust frontend)
- Stock validated at checkout and re-checked at payment verification
- Razorpay signature verification using HMAC SHA-256 on backend
- Payment secrets stored in environment variables (never exposed to frontend)
- Transaction-safe inventory updates
- Idempotent payment verification and webhook handling
- No card data stored
- Test mode clearly indicated in UI

## Razorpay Test Mode

Use test cards from [Razorpay Test Card Details](https://razorpay.com/docs/payments/payment-gateway/test-card-upi-details/). For example:
- Card: 4111 1111 1111 1111, any future expiry, any CVV

## Remaining Limitations & Next Steps

### Limitations
- Webhook stock decrement may double-decrement in some edge cases without more sophisticated idempotency tracking
- No user authentication (guest checkout only)
- No order history for customers (only accessible via order ID)
- No email notifications
- Basic error handling
- No admin panel for product/order management

### Recommended Next Steps
- Add user authentication and order history
- Implement proper webhook idempotency using event IDs
- Add email/SMS notifications
- Build admin dashboard
- Add product reviews/ratings
- Implement discount codes/coupons
- Add shipping cost calculation
- Enhance search with filters
- Add more comprehensive tests
- Implement UCP/AP2/ACP protocols as planned

## Project Structure

`
ecommerce-poc/
├── frontend/          # React + Vite frontend
├── backend/           # Express + Prisma backend
└── README.md
`

## License

This project is for POC purposes.
