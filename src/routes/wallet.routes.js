const express = require('express');
const router = express.Router();

const { getMyWallet, requestWithdrawal, getMyWithdrawals } = require('../controllers/wallet.controller');
const { protect } = require('../middlewares/auth.middleware');

router.get('/me', protect, getMyWallet);
router.post('/withdraw', protect, requestWithdrawal);
router.get('/withdrawals', protect, getMyWithdrawals);

module.exports = router;