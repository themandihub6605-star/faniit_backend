const express = require('express');
const router = express.Router();

const { getMyWallet, previewWithdrawal, requestWithdrawal, getMyWithdrawals, getMyTransactions } = require('../controllers/wallet.controller');
const { protect } = require('../middlewares/auth.middleware');

router.get('/me', protect, getMyWallet);
router.get('/transactions', protect, getMyTransactions);
router.get('/withdraw/preview', protect, previewWithdrawal);
router.post('/withdraw', protect, requestWithdrawal);
router.get('/withdrawals', protect, getMyWithdrawals);

module.exports = router;