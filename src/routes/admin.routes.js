const express = require('express');
const router = express.Router();

const admin = require('../controllers/admin.controller');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { ROLES } = require('../constants/enums');

// every route below requires a logged-in admin
router.use(protect, authorize(ROLES.ADMIN));

// Users
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
router.post('/notifications/broadcast', admin.broadcastNotification);

// Admin accounts
router.get('/admins', admin.listAdmins);
router.post('/admins', admin.createAdmin);

// Content moderation
router.get('/sessions', admin.listAllSessions);
router.patch('/sessions/:id/remove', admin.removeSession);
router.get('/campaigns', admin.listAllCampaigns);
router.get('/reviews', admin.listAllReviews);
router.patch('/reviews/:id/hide', admin.hideReview);

// Payments / Escrow / Disputes
router.get('/transactions', admin.listAllTransactions);
router.get('/disputes/escrow', admin.listDisputedEscrows);
router.post('/escrow/:campaignId/release', admin.adminReleaseEscrow);
router.post('/escrow/:campaignId/refund', admin.adminRefundEscrow);

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