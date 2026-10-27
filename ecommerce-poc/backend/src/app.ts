import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import productRoutes from './routes/productRoutes';
import orderRoutes from './routes/orderRoutes';
import paymentRoutes from './routes/paymentRoutes';
import { createUcpRouter } from './ucp/routes';
import { discoveryHandler } from './ucp/profile';

dotenv.config();

const app = express();

app.use(helmet());
app.use(morgan('dev'));

// UCP: called server-to-server by platforms, so it sits before the browser CORS policy
// below and parses its own raw bodies (needed for request-signature verification).
app.get('/.well-known/ucp', cors({ origin: '*' }), discoveryHandler);
app.use('/ucp/v1', createUcpRouter());

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));

// For webhook raw body if needed - simple approach
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  if (Buffer.isBuffer(req.body)) {
    (req as any).rawBody = req.body.toString('utf8');
    try {
      req.body = JSON.parse((req as any).rawBody);
    } catch {
      req.body = {};
    }
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mode: 'test' });
});

app.use('/api/products', productRoutes);
app.use('/api', orderRoutes);
app.use('/api/payments', paymentRoutes);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

export default app;
