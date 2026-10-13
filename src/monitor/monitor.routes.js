const express = require('express');
const c = require('./monitor.controller');
const insights = require('./insights.controller');
const manage = require('./manage.controller');
const features = require('./features');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { ROLES } = require('../constants/enums');

// Mounted at /api/admin/monitor — admins only, read-only (except "resolve").
const router = express.Router();
router.use(protect, authorize(ROLES.ADMIN));

router.get('/attention', c.attention);
router.get('/overview', c.overview);
router.get('/activity', c.activity);
router.get('/audit-logs', c.auditLogs);
router.get('/auth-events', c.authEvents);
router.get('/system', c.system);
router.patch('/issues/:id/resolve', c.resolveIssue);
router.get('/search', c.search);

// Insights
router.get('/leaderboards', insights.leaderboards);
router.get('/finance', insights.finance);
router.get('/content', insights.content);
router.get('/growth', insights.growth);

// Manage
router.get('/reviews', manage.listReviews);
router.patch('/reviews/:id', manage.setReviewVisibility);
router.get('/stories', manage.listStories);
router.delete('/stories/:id', manage.deleteStory);
router.get('/gifts', manage.listGifts);
router.get('/sessions', manage.listSessions);
router.get('/sessions/:id/bookings', manage.sessionBookings);
router.post('/sessions/:id/cancel', manage.cancelSession);
router.get('/bookings', manage.listBookings);
router.get('/applications', manage.listApplications);
router.get('/wallets', manage.listWallets);
router.get('/community-content', manage.listCommunityContent);
router.delete('/community-content/:kind/:id', manage.removeCommunityContent);
router.get('/communities/:id/members', manage.communityMembers);
router.get('/disputes/history', manage.disputeHistory);
router.get('/legal', manage.listLegal);
router.put('/legal/:slug', manage.saveLegal);
router.get('/users', manage.searchUsers);
router.get('/users/:id/overview', manage.userOverview);

// App feature switches (Fanitt Store on/off)
router.get('/features', features.getFeaturesAdmin);
router.patch('/features', features.updateFeaturesAdmin);

module.exports = router;