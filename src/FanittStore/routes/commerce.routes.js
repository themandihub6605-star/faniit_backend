const express = require('express');
const { protect, optionalAuth } = require('../../middlewares/auth.middleware');
const { authorize } = require('../../middlewares/role.middleware');
const validate = require('../../middlewares/validate.middleware');
const { uploadImage } = require('../../middlewares/upload.middleware');
const v = require('../validators/commerce.validators');
const c = require('../controllers/commerce.controller');

// Physical products — mounted at /api/store/shop
const router = express.Router();
const creatorOnly = [protect, authorize('creator')];
const images = uploadImage('fanitt/shop').array('images', 4);

// ---------- Public ----------
router.get('/config', c.getConfig);
router.get('/products', optionalAuth, c.listProducts);
router.get('/products/:id', optionalAuth, c.getProduct);

// ---------- Buyer: cart ----------
router.get('/cart', protect, c.getCart);
router.get('/cart/count', protect, c.getCartCount);
router.post('/cart/items', protect, validate(v.cartAddSchema), c.addToCart);
router.patch('/cart/items/:itemId', protect, validate(v.cartUpdateSchema), c.updateCartItem);
router.delete('/cart/items/:itemId', protect, c.removeCartItem);
router.delete('/cart', protect, c.clearCart);

// ---------- Buyer: addresses ----------
router.get('/addresses', protect, c.listAddresses);
router.post('/addresses', protect, validate(v.addressSchema), c.createAddress);
router.patch('/addresses/:id', protect, validate(v.addressUpdateSchema), c.updateAddress);
router.post('/addresses/:id/default', protect, c.setDefaultAddress);
router.delete('/addresses/:id', protect, c.deleteAddress);

// ---------- Buyer: checkout & orders ----------
router.post('/checkout/preview', protect, validate(v.checkoutLinesSchema), c.previewCheckout);
router.post('/checkout', protect, validate(v.checkoutSchema), c.checkout);
router.post('/checkout/:checkoutId/verify', protect, validate(v.verifySchema), c.verifyCheckout);
router.get('/orders', protect, c.listMyOrders);
router.get('/orders/:id', protect, c.getMyOrder);
router.post('/orders/:id/cancel', protect, validate(v.cancelSchema), c.cancelMyOrder);
router.post('/orders/:id/received', protect, c.markReceived);

// ---------- Seller: products ----------
router.get('/me/summary', ...creatorOnly, c.getSellerSummary);
router.get('/me/products', ...creatorOnly, c.listMyProducts);
router.post('/me/products', ...creatorOnly, validate(v.shopProductCreateSchema), c.createProduct);
router.get('/me/products/:id', ...creatorOnly, c.getMyProduct);
router.patch('/me/products/:id', ...creatorOnly, validate(v.shopProductUpdateSchema), c.updateProduct);
router.delete('/me/products/:id', ...creatorOnly, c.deleteProduct);
router.post('/me/products/:id/images', ...creatorOnly, images, c.uploadImages);
router.put('/me/products/:id/images', ...creatorOnly, validate(v.imageOrderSchema), c.reorderImages);
router.delete('/me/products/:id/images', ...creatorOnly, validate(v.imageRemoveSchema), c.removeImage);
router.post('/me/products/:id/publish', ...creatorOnly, c.publishProduct);
router.post('/me/products/:id/unpublish', ...creatorOnly, c.unpublishProduct);

// ---------- Seller: orders ----------
router.get('/me/orders', ...creatorOnly, c.listSellerOrders);
router.get('/me/orders/:id', ...creatorOnly, c.getSellerOrder);
router.post('/me/orders/:id/confirm', ...creatorOnly, c.confirmOrder);
router.post('/me/orders/:id/ship', ...creatorOnly, validate(v.shipSchema), c.shipOrder);
router.post('/me/orders/:id/deliver', ...creatorOnly, c.deliverOrder);
router.post('/me/orders/:id/cancel', ...creatorOnly, validate(v.cancelSchema), c.sellerCancelOrder);

module.exports = router;