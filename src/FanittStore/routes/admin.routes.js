const express = require('express');
const { protect } = require('../../middlewares/auth.middleware');
const { authorize } = require('../../middlewares/role.middleware');
const validate = require('../../middlewares/validate.middleware');
const { uploadImage } = require('../../middlewares/upload.middleware');
const v = require('../validators/store.validators');
const admin = require('../controllers/admin.controller');
const analytics = require('../controllers/analytics.controller');

const router = express.Router();
router.use(protect, authorize('admin'));
const image = uploadImage('fanitt/store-admin').single('image');

router.get('/overview', admin.getOverview);
router.get('/analytics', analytics.getPlatformAnalytics);

router.get('/affiliate', admin.listAffiliateProducts);
router.patch('/affiliate/:id/remove', validate(v.reasonSchema), admin.removeAffiliateProduct);
router.patch('/affiliate/:id/restore', admin.restoreAffiliateProduct);
router.get('/fanbox', admin.listFanbox);

router.get('/stores', admin.listStores);
router.get('/stores/:id', admin.getStore);
router.patch('/stores/:id/kyc', validate(v.kycDecisionSchema), admin.reviewKyc);
router.patch('/stores/:id/status', validate(v.storeStatusSchema), admin.setStoreStatus);

router.get('/products', admin.listProducts);
router.patch('/products/:id/remove', validate(v.reasonSchema), admin.removeProduct);
router.patch('/products/:id/restore', admin.restoreProduct);

router.get('/orders', admin.listOrders);
router.post('/orders/:id/refund', validate(v.reasonSchema), admin.refundOrder);

router.get('/lives', admin.listLives);
router.post('/lives/:id/end', validate(v.reasonSchema), admin.endLive);
router.get('/calls', admin.listCalls);
router.post('/calls/:id/end', admin.endCall);

router.get('/settings', admin.getSettings);
router.patch('/settings', validate(v.settingsSchema), admin.updateSettings);
router.patch('/tool-cards/:key', validate(v.toolCardSchema), admin.updateToolCard);
router.post('/tool-cards/:key/image', image, admin.uploadToolCardImage);
router.patch('/banner', validate(v.bannerSchema), admin.updateBanner);
router.post('/banner/image', image, admin.uploadBannerImage);

module.exports = router;
