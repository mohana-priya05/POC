import { Router } from 'express';
import { getProducts, getProductById, searchProducts, getCategories } from '../controllers/productController';

const router = Router();

router.get('/', getProducts);
router.get('/search', searchProducts);
router.get('/categories', getCategories);
router.get('/:id', getProductById);

export default router;
