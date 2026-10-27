import { Router } from 'express';
import { checkout, getOrderById } from '../controllers/orderController';
import { validate } from '../middleware/validate';
import { checkoutSchema } from '../validators/checkoutValidator';

const router = Router();

router.post('/checkout', validate(checkoutSchema), checkout);
router.get('/orders/:orderId', getOrderById);

export default router;
