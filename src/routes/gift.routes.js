const express = require('express');
const router = express.Router();

const { createGiftOrder, verifyGift, getCreatorGifts } = require('../controllers/gift.controller');
const { protect } = require('../middlewares/auth.middleware');

router.post('/create-order', protect, createGiftOrder);
router.post('/verify', protect, verifyGift);
router.get('/creator/:creatorId', getCreatorGifts);

module.exports = router;