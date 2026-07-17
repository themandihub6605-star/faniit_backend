const express = require('express');
const router = express.Router();

const { getMyTransactions } = require('../controllers/payment.controller');
const { protect } = require('../middlewares/auth.middleware');

// NOTE: the /webhook route is registered directly in app.js (not here),
// because it needs express.raw() for signature verification instead of
// the standard express.json() parser used everywhere else.
router.get('/me/transactions', protect, getMyTransactions);

module.exports = router;
