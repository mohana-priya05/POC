import Joi from 'joi';

export const checkoutSchema = Joi.object({
  customerName: Joi.string().min(2).max(100).required(),
  customerEmail: Joi.string().email().required(),
  customerPhone: Joi.string().pattern(/^[0-9+\-\s()]{7,20}$/).required(),
  deliveryAddress: Joi.string().min(5).max(500).required(),
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().uuid().required(),
      quantity: Joi.number().integer().min(1).required(),
    })
  ).min(1).required(),
});
