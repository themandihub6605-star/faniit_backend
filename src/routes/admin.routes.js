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
router.patch('/users/:id/suspend', admin.suspendUser);
router.patch('/users/:id/reinstate', admin.reinstateUser);

// Verification
router.get('/verifications/pending', admin.listPendingVerifications);
router.patch('/verifications/creator/:id', admin.verifyCreator);
router.patch('/verifications/brand/:id', admin.verifyBrand);

// Agency approval
router.get('/agencies', admin.listAgencies);
router.patch('/agencies/:id/verify', admin.verifyAgency);

// Content moderation
router.get('/sessions', admin.listAllSessions);
router.patch('/sessions/:id/remove', admin.removeSession);
router.get('/campaigns', admin.listAllCampaigns);
router.patch('/reviews/:id/hide', admin.hideReview);

// Payments / Escrow / Disputes
router.get('/transactions', admin.listAllTransactions);
router.get('/disputes/escrow', admin.listDisputedEscrows);
router.post('/escrow/:campaignId/release', admin.adminReleaseEscrow);
router.post('/escrow/:campaignId/refund', admin.adminRefundEscrow);

// Analytics
router.get('/analytics/overview', admin.getAnalyticsOverview);

// Categories
router.post('/categories', admin.createCategory);
router.patch('/categories/:id', admin.updateCategory);
router.delete('/categories/:id', admin.deleteCategory);

module.exports = router;
