const express = require('express');
const router = express.Router();

const admin = require('../controllers/admin.controller');
const adminPosts = require('../controllers/adminPost.controller');
const broadcasts = require('../controllers/broadcast.controller');
const adminCampaigns = require('../controllers/adminCampaign.controller');
const homeLayout = require('../controllers/homeLayout.controller');
const { uploadImage } = require('../middlewares/upload.middleware');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { ROLES } = require('../constants/enums');

// every route below requires a logged-in admin
router.use(protect, authorize(ROLES.ADMIN));

// Users
// App home screen sections (order, titles, pinned items)
router.get('/home-layout', homeLayout.getAdminLayout);
router.put('/home-layout', homeLayout.saveLayout);
router.get('/home-layout/search', homeLayout.searchItems);

router.get('/users', admin.listUsers);
router.get('/users/:id', admin.getUserDetail);
router.patch('/users/:id/suspend', admin.suspendUser);
router.patch('/users/:id/reinstate', admin.reinstateUser);
router.get('/users/:id/subscription', admin.getUserSubscription);
router.patch('/users/:id/subscription', admin.setUserSubscription);

// Verification
router.get('/verifications/pending', admin.listPendingVerifications);
router.patch('/verifications/creator/:id', admin.verifyCreator);
router.patch('/verifications/brand/:id', admin.verifyBrand);

// Agency approval
router.post('/agencies', admin.createAgency);
router.get('/agencies', admin.listAgencies);
router.patch('/agencies/:id/verify', admin.verifyAgency);
router.patch('/agencies/:id/set-password', admin.setAgencyPassword);

// Referral commission config
router.get('/referral-config', admin.getReferralConfig);
router.patch('/referral-config', admin.updateReferralConfig);

// Withdrawal requests — status flow: initiated -> processing -> completed
//                                                              -> rejected
router.get('/withdrawals', admin.listWithdrawals);
router.patch('/withdrawals/:id/processing', admin.markWithdrawalProcessing);
router.patch('/withdrawals/:id/paid', admin.markWithdrawalPaid);
router.patch('/withdrawals/:id/reject', admin.rejectWithdrawal);

// Site settings
router.get('/settings', admin.getSiteSettings);
router.patch('/settings', admin.updateSiteSettings);

// Broadcast notifications
router.post('/notifications/broadcast', uploadImage('fanitt/notifications').single('image'), broadcasts.createBroadcast);
router.get('/notifications/audience', broadcasts.audienceCount);
router.get('/notifications/broadcasts', broadcasts.listBroadcasts);
router.patch('/notifications/broadcasts/:id/cancel', broadcasts.cancelBroadcast);
router.patch('/notifications/broadcasts/:id/reschedule', broadcasts.reschedule);
router.post('/notifications/broadcasts/:id/send-now', broadcasts.sendNow);

// Admin accounts
router.get('/admins', admin.listAdmins);
router.post('/admins', admin.createAdmin);

// Content moderation
router.get('/sessions', admin.listAllSessions);
router.patch('/sessions/:id/remove', admin.removeSession);
router.get('/campaigns', admin.listAllCampaigns);

// Campaign review & management
router.get('/campaigns/rules', adminCampaigns.getRules);
router.patch('/campaigns/rules', adminCampaigns.updateRules);
router.get('/campaigns/all', adminCampaigns.listCampaigns);
router.get('/campaigns/:id/details', adminCampaigns.getCampaignDetails);
router.patch('/campaigns/:id/approve', adminCampaigns.approveCampaign);
router.patch('/campaigns/:id/reject', adminCampaigns.rejectCampaign);
router.patch('/campaigns/:id/unpublish', adminCampaigns.unpublishCampaign);
router.get('/reviews', admin.listAllReviews);
router.patch('/reviews/:id/hide', admin.hideReview);

// Posts (creator feed + community) — search, edit, delete
router.get('/posts', adminPosts.listPosts);
router.patch('/posts/:type/:id', adminPosts.updatePost);
router.delete('/posts/:type/:id', adminPosts.deletePost);

// Payments / Escrow / Disputes
router.get('/transactions', admin.listAllTransactions);
router.get('/disputes/escrow', admin.listDisputedEscrows);
router.post('/escrow/:campaignId/release', admin.adminReleaseEscrow);
router.post('/escrow/:campaignId/refund', admin.adminRefundEscrow);

// Milestones — platform-wide status tracking (NEW)
router.get('/milestones', admin.listAllMilestones);

// Analytics
router.get('/analytics/overview', admin.getAnalyticsOverview);

// Categories
router.get('/categories', admin.listCategoriesAdmin);
router.post('/categories', admin.createCategory);
router.patch('/categories/:id', admin.updateCategory);
router.delete('/categories/:id', admin.deleteCategory);

// Subscription plans (Creator Lite/Pro, Brand Lite/Pro/Elite)
router.get('/subscription-plans', admin.listSubscriptionPlansAdmin);
router.post('/subscription-plans', admin.createSubscriptionPlan);
router.patch('/subscription-plans/:id', admin.updateSubscriptionPlan);
router.delete('/subscription-plans/:id', admin.deleteSubscriptionPlan);

module.exports = router;