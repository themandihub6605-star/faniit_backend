const express = require('express');
const router = express.Router();

const c = require('../controllers/post.controller');
const { protect, optionalAuth } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { uploadMedia } = require('../middlewares/upload.middleware');
const { ROLES } = require('../constants/enums');

// Creators and brands post; everyone can read.
const poster = [protect, authorize(ROLES.CREATOR, ROLES.BRAND)];

router.get('/config', c.getConfig);
router.get('/feed', optionalAuth, c.getFeed);
router.get('/reels', optionalAuth, c.getReels);
router.get('/me', ...poster, c.getMyPosts);
router.get('/me/stats', protect, c.getMyStats);
router.get('/saved', protect, c.getSavedPosts);
router.get('/creator/:creatorId', optionalAuth, c.getCreatorPosts);
router.get('/brand/:brandId', optionalAuth, c.getBrandPosts);
router.post('/', ...poster, uploadMedia('fanitt/creator-posts').array('media', 10), c.createPost);
router.get('/:id', optionalAuth, c.getPost);
router.post('/:id/like', protect, c.toggleLike);
router.post('/:id/save', protect, c.toggleSave);
router.post('/:id/view', optionalAuth, c.addView);
router.get('/:id/likes', c.getPostLikes);
router.patch('/:id', protect, c.updatePost);
router.delete('/:id', protect, c.deletePost);

module.exports = router;