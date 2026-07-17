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
const { protect } = require('../middlewares/auth.middleware');

router.get('/', listCreators);
router.get('/me', protect, getMyProfile);
router.get('/me/dashboard', protect, getMyDashboard);
router.patch('/me', protect, updateMyProfile);
router.post('/:id/follow', protect, followCreator);
router.get('/:slug', getCreatorBySlug);

module.exports = router;
