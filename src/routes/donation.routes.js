const express = require('express');
const router = express.Router();

const { createDonationOrder, verifyDonation, getSessionDonations } = require('../controllers/donation.controller');
const { protect } = require('../middlewares/auth.middleware');

router.post('/create-order', protect, createDonationOrder);
router.post('/verify', protect, verifyDonation);
router.get('/session/:sessionId', getSessionDonations);

module.exports = router;
