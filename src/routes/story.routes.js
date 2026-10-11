const express = require('express');
const router = express.Router();

const c = require('../controllers/story.controller');
const { protect, optionalAuth } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { uploadMedia } = require('../middlewares/upload.middleware');
const { ROLES } = require('../constants/enums');

// 24-hour stories. Creators and brands post; everyone can watch.
const poster = [protect, authorize(ROLES.CREATOR, ROLES.BRAND)];

router.get('/', optionalAuth, c.getStoryFeed);
router.get('/me', ...poster, c.getMyStories);
router.get('/user/:id', optionalAuth, c.getUserStories);
router.post('/', ...poster, uploadMedia('fanitt/stories').single('media'), c.createStory);
router.post('/:id/view', protect, c.markViewed);
router.get('/:id/viewers', protect, c.getViewers);
router.delete('/:id', protect, c.deleteStory);

module.exports = router;