const express = require('express');
const router = express.Router();

// Admin monitoring — records admin actions, logins and API errors (src/monitor).
const monitor = require('../monitor');
router.use(monitor.tracker);

// Public webhook routes (no auth) — keep at top
router.use('/whatsapp', require('./whatsapp.routes'));

router.use('/auth', require('./auth.routes'));
router.use('/users', require('./user.routes'));
router.use('/creators', require('./creator.routes'));
router.use('/sessions', require('./session.routes'));
router.use('/bookings', require('./booking.routes'));
router.use('/brands', require('./brand.routes'));
router.use('/campaigns', require('./campaign.routes'));
router.use('/milestones', require('./milestone.routes'));
router.use('/disputes', require('./dispute.routes'));
router.use('/payments', require('./payment.routes'));
router.use('/donations', require('./donation.routes'));
router.use('/reviews', require('./review.routes'));
router.use('/agency', require('./agency.routes'));
router.use('/notifications', require('./notification.routes'));
router.use('/categories', require('./category.routes'));
router.use('/stats', require('./stats.routes'));
router.use('/communities', require('./community.routes'));
router.use('/chat', require('./chat.routes'));
router.use('/gifts', require('./gift.routes'));
router.use('/posts', require('./post.routes'));
router.use('/stories', require('./story.routes'));
router.use('/wallet', require('./wallet.routes'));
// Before '/admin' so admin.routes doesn't catch them first.
router.use('/admin/monitor', monitor.routes);
router.use('/admin/account-deletions', require('./accountDeletion.routes'));
router.use('/admin', require('./admin.routes'));
router.use('/home', require('./home.routes'));
router.use('/subscriptions', require('./subscription.routes'));
router.use('/analytics', require('./appAnalytics.routes')); // app screen tracking + admin report
router.use('/legal', require('./legal.routes')); // Privacy Policy / Terms

// Fanitt Store — all store code lives in src/FanittStore
router.use('/store', require('../FanittStore'));

router.get('/health', (req, res) => res.json({ success: true, message: 'Fanitt API is running' }));

module.exports = router;