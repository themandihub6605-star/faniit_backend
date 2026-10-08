const express = require('express');
const { protect } = require('../../middlewares/auth.middleware');
const { authorize } = require('../../middlewares/role.middleware');
const validate = require('../../middlewares/validate.middleware');
const v = require('../validators/commerce.validators');
const a = require('../controllers/adminCommerce.controller');

// Admin: physical products & orders — mounted at /api/store/admin/shop
const router = express.Router();
router.use(protect, authorize('admin'));

router.get('/overview', a.getOverview);
router.get('/settings', a.getSettings);
router.patch('/settings', validate(v.shopSettingsSchema), a.updateSettings);

router.get('/products', a.listProducts);
router.patch('/products/:id/remove', validate(v.reasonSchema), a.removeProduct);
router.patch('/products/:id/restore', a.restoreProduct);

router.get('/orders', a.listOrders);
router.get('/orders/:id', a.getOrder);
router.post('/orders/:id/cancel', validate(v.reasonSchema), a.cancelOrder);
router.post('/orders/:id/refund', a.retryRefund);

module.exports = router;