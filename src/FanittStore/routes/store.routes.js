const express = require('express');
const { protect, optionalAuth } = require('../../middlewares/auth.middleware');
const { authorize } = require('../../middlewares/role.middleware');
const validate = require('../../middlewares/validate.middleware');
const { uploadImage } = require('../../middlewares/upload.middleware');
const v = require('../validators/store.validators');
const { kycUpload } = require('../utils/upload');
const store = require('../controllers/store.controller');
const product = require('../controllers/product.controller');
const shop = require('../controllers/shop.controller');
const live = require('../controllers/live.controller');
const call = require('../controllers/call.controller');
const meet = require('../controllers/meet.controller');
const affiliate = require('../controllers/affiliate.controller');
const fanbox = require('../controllers/fanbox.controller');
const analytics = require('../controllers/analytics.controller');

const router = express.Router();
const creatorOnly = [protect, authorize('creator')];
const image = uploadImage('fanitt/store').single('image');

// ---------- Public ----------
router.get('/config', shop.getConfig);
router.get('/stores', shop.listStores);
router.get('/stores/:slugOrUserId', optionalAuth, shop.getStore);
router.get('/products', optionalAuth, shop.listProducts);
router.get('/products/:id', optionalAuth, shop.getProduct);
router.get('/lives', live.listLives);
router.get('/lives/discover', optionalAuth, live.discoverLives);
router.get('/lives/community/:communityId', optionalAuth, live.communityLives);
router.get('/lives/:id', optionalAuth, live.getLive);
router.get('/meets', optionalAuth, meet.listMeets);
router.get('/meets/:id', optionalAuth, meet.getMeet);
router.post('/meets/:id/join', protect, meet.joinMeet);
router.post('/meets/:id/end', protect, meet.endMeet);
router.get('/go/:id', optionalAuth, affiliate.go);
router.get('/fanbox/config', fanbox.getConfig);

// ---------- Creator: my store ----------
router.get('/me', ...creatorOnly, store.getMyStore);
router.post('/me', ...creatorOnly, validate(v.storeProfileSchema), store.createStore);
router.patch('/me', ...creatorOnly, validate(v.storeProfileUpdateSchema), store.updateStore);
router.post('/me/logo', ...creatorOnly, image, store.uploadStoreImage('logoUrl'));
router.post('/me/banner', ...creatorOnly, image, store.uploadStoreImage('bannerUrl'));
router.put('/me/payout', ...creatorOnly, validate(v.payoutSchema), store.savePayout);
router.post('/me/kyc', ...creatorOnly, kycUpload, validate(v.kycSchema), store.submitKyc);
router.post('/me/terms', ...creatorOnly, validate(v.termsSchema), store.acceptTerms);
router.get('/me/summary', ...creatorOnly, product.getMySummary);
router.get('/me/sales', ...creatorOnly, product.listMySales);

// ---------- Creator: products ----------
router.get('/me/products', ...creatorOnly, product.listMyProducts);
router.post('/me/products', ...creatorOnly, validate(v.productCreateSchema), product.createProduct);
router.get('/me/products/:id', ...creatorOnly, product.getMyProduct);
router.patch('/me/products/:id', ...creatorOnly, validate(v.productUpdateSchema), product.updateProduct);
router.delete('/me/products/:id', ...creatorOnly, product.deleteProduct);
router.post('/me/products/:id/cover', ...creatorOnly, image, product.uploadCover);
router.post('/me/products/:id/files/upload-url', ...creatorOnly, validate(v.fileUploadRequestSchema), product.requestFileUpload);
router.post('/me/products/:id/files', ...creatorOnly, validate(v.fileConfirmSchema), product.confirmFile);
router.delete('/me/products/:id/files/:fileId', ...creatorOnly, product.removeFile);
router.get('/me/products/:id/files/:fileId/preview', ...creatorOnly, product.previewFile);
router.post('/me/products/:id/publish', ...creatorOnly, product.publishProduct);
router.post('/me/products/:id/unpublish', ...creatorOnly, product.unpublishProduct);

// ---------- Creator: live streams ----------
router.get('/me/lives', ...creatorOnly, live.listMyLives);
router.post('/me/lives', ...creatorOnly, validate(v.liveCreateSchema), live.createLive);
router.get('/me/lives/:id', ...creatorOnly, live.getMyLive);
router.patch('/me/lives/:id', ...creatorOnly, validate(v.liveUpdateSchema), live.updateLive);
router.post('/me/lives/:id/cover', ...creatorOnly, image, live.uploadLiveCover);
router.post('/me/lives/:id/start', ...creatorOnly, live.startLive);
router.post('/me/lives/:id/end', ...creatorOnly, live.endLive);
router.post('/me/lives/:id/cancel', ...creatorOnly, validate(v.reasonSchema), live.cancelLive);

// ---------- Creator: calls & meets ----------
router.get('/me/calls/settings', ...creatorOnly, call.getSettings);
router.patch('/me/calls/settings', ...creatorOnly, validate(v.callSettingsSchema), call.updateSettings);
router.post('/me/calls/online', ...creatorOnly, validate(v.callOnlineSchema), call.setOnline);
router.get('/me/meets', ...creatorOnly, meet.listMyMeets);

// ---------- Creator: affiliate ----------
router.post('/me/affiliate/preview', ...creatorOnly, validate(v.affiliatePreviewSchema), affiliate.previewLink);
router.get('/me/affiliate/products', ...creatorOnly, affiliate.listMyProducts);
router.post('/me/affiliate/products', ...creatorOnly, validate(v.affiliateProductSchema), affiliate.createProduct);
router.patch('/me/affiliate/products/:id', ...creatorOnly, validate(v.affiliateProductUpdateSchema), affiliate.updateProduct);
router.post('/me/affiliate/products/:id/image', ...creatorOnly, image, affiliate.uploadProductImage);
router.delete('/me/affiliate/products/:id', ...creatorOnly, affiliate.deleteProduct);
router.get('/me/affiliate/collections', ...creatorOnly, affiliate.listMyCollections);
router.post('/me/affiliate/collections', ...creatorOnly, validate(v.affiliateCollectionSchema), affiliate.createCollection);
router.patch('/me/affiliate/collections/:id', ...creatorOnly, validate(v.affiliateCollectionUpdateSchema), affiliate.updateCollection);
router.post('/me/affiliate/collections/:id/cover', ...creatorOnly, image, affiliate.uploadCollectionCover);
router.delete('/me/affiliate/collections/:id', ...creatorOnly, affiliate.deleteCollection);
router.get('/me/affiliate/earnings', ...creatorOnly, affiliate.listMyEarnings);
router.post('/me/affiliate/earnings', ...creatorOnly, validate(v.affiliateEarningSchema), affiliate.addEarning);
router.patch('/me/affiliate/earnings/:id', ...creatorOnly, validate(v.affiliateEarningUpdateSchema), affiliate.updateEarning);
router.delete('/me/affiliate/earnings/:id', ...creatorOnly, affiliate.deleteEarning);

// ---------- Creator: FanBox & analytics ----------
router.get('/me/fanbox', ...creatorOnly, fanbox.listReceived);
router.get('/me/analytics', ...creatorOnly, analytics.getMyAnalytics);
router.get('/me/customers', ...creatorOnly, analytics.getMyCustomers);

// ---------- Buyers (any logged-in user) ----------
router.post('/products/:id/checkout', protect, validate(v.checkoutSchema), shop.checkout);
router.post('/lives/:id/checkout', protect, validate(v.checkoutSchema), live.buyTicket);
router.post('/lives/:id/join', protect, validate(v.joinLiveSchema), live.joinLive);
router.post('/stores/:storeId/calls', protect, validate(v.callRequestSchema), call.requestCall);
router.post('/fanbox', protect, validate(v.fanboxSchema), fanbox.send);
router.get('/fanbox/sent', protect, fanbox.listSent);
router.get('/calls', protect, call.listMyCalls);
router.get('/calls/:id', protect, call.getCall);
router.post('/calls/:id/accept', protect, call.accept);
router.post('/calls/:id/decline', protect, call.decline);
router.post('/calls/:id/cancel', protect, call.cancel);
router.post('/calls/:id/join', protect, call.joinCall);
router.post('/calls/:id/end', protect, call.end);
router.post('/orders/:id/verify', protect, validate(v.verifyPaymentSchema), shop.verifyPayment);
router.get('/orders/mine', protect, shop.listMyOrders);
router.get('/orders/:id/invoice', protect, shop.getInvoice);
router.get('/orders/:id/invoice.html', protect, shop.getInvoiceHtml);
router.get('/library', protect, shop.getLibrary);
router.get('/library/:productId/files/:fileId/download', protect, shop.downloadFile);

module.exports = router;