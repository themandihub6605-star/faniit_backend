const express = require('express');
const router = express.Router();

const { getMyWallet } = require('../controllers/wallet.controller');
const { protect } = require('../middlewares/auth.middleware');

router.get('/me', protect, getMyWallet);

module.exports = router;