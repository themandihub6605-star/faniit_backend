const express = require('express');
const router = express.Router();

const {
  listCreators,
  getCreatorBySlug,
  getMyProfile,
  updateMyProfile,
  getMyDashboard,
  followCreator,
} = require('../controllers/creator.controller');
const { protect, optionalAuth } = require('../middlewares/auth.middleware');

router.get('/', optionalAuth, listCreators);
router.get('/me', protect, getMyProfile);
router.get('/me/dashboard', protect, getMyDashboard);
router.patch('/me', protect, updateMyProfile);
router.post('/:id/follow', protect, followCreator);
router.get('/:slug', optionalAuth, getCreatorBySlug);

module.exports = router;