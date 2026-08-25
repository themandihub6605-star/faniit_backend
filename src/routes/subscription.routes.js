const express = require('express');
const router = express.Router();

const { listPlans, getMySubscription, createCheckout, verifyCheckout, cancelSubscription } = require('../controllers/subscription.controller');
const { protect } = require('../middlewares/auth.middleware');

router.get('/plans', listPlans);
router.get('/me', protect, getMySubscription);
router.post('/checkout', protect, createCheckout);
router.post('/verify', protect, verifyCheckout);
router.post('/cancel', protect, cancelSubscription);

module.exports = router;