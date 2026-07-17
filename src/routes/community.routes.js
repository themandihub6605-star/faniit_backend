const express = require('express');
const router = express.Router();

const {
  listCommunities,
  getCommunityBySlug,
  createCommunity,
  toggleMembership,
  getMyCommunities,
} = require('../controllers/community.controller');
const { protect } = require('../middlewares/auth.middleware');

router.get('/', listCommunities);
router.get('/me', protect, getMyCommunities);
router.post('/', protect, createCommunity);
router.post('/:id/join', protect, toggleMembership);
router.get('/:slug', getCommunityBySlug);

module.exports = router;