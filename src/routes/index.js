const express = require('express');
const router = express.Router();

router.use('/auth', require('./auth.routes'));
router.use('/users', require('./user.routes'));
router.use('/creators', require('./creator.routes'));
router.use('/sessions', require('./session.routes'));
router.use('/bookings', require('./booking.routes'));
router.use('/brands', require('./brand.routes'));
router.use('/campaigns', require('./campaign.routes'));
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
router.use('/wallet', require('./wallet.routes'));
router.use('/admin', require('./admin.routes'));

router.get('/health', (req, res) => res.json({ success: true, message: 'Fanitt API is running' }));

module.exports = router;