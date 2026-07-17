const express = require('express');
const router = express.Router();

const { createReview, getUserReviews, getFeaturedReviews } = require('../controllers/review.controller');
const { protect } = require('../middlewares/auth.middleware');

router.get('/featured', getFeaturedReviews);
router.post('/', protect, createReview);
router.get('/user/:userId', getUserReviews);

module.exports = router;