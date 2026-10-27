import { Router } from 'express';
import { createRazorpayOrder, verifyPayment, webhook } from '../controllers/paymentController';

const router = Router();

router.post('/create-order', createRazorpayOrder);
router.post('/verify', verifyPayment);
router.post('/webhook', webhook);

export default router;
