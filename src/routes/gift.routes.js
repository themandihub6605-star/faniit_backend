const express = require('express');
const router = express.Router();

const { createGiftOrder, verifyGift, getCreatorGifts } = require('../controllers/gift.controller');
const { protect } = require('../middlewares/auth.middleware');

// Sending a gift requires login (frontend already checks isAuthenticated,
// but that's UI-only — protect here is what actually stops an
// unauthenticated request from reaching the payment/wallet logic).
router.post('/create-order', protect, createGiftOrder);
router.post('/verify', protect, verifyGift);

// Public — anyone viewing a creator's profile can see their gifts feed,
// same as reviews are public.
router.get('/creator/:creatorId', getCreatorGifts);

module.exports = router;