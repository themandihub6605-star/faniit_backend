const express = require('express');
const router = express.Router();

const { createPost, getCreatorPosts, getMyPosts, getFeed, toggleLike, getPostLikes, updatePost, deletePost } = require('../controllers/post.controller');
const { protect, optionalAuth } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { uploadMedia } = require('../middlewares/upload.middleware');
const { ROLES } = require('../constants/enums');

router.get('/feed', optionalAuth, getFeed);
router.get('/me', protect, authorize(ROLES.CREATOR), getMyPosts);
router.get('/creator/:creatorId', optionalAuth, getCreatorPosts);
router.post('/', protect, authorize(ROLES.CREATOR), uploadMedia('fanitt/creator-posts').array('media', 5), createPost);
router.post('/:id/like', protect, toggleLike);
router.get('/:id/likes', getPostLikes);
router.patch('/:id', protect, updatePost);
router.delete('/:id', protect, deletePost);

module.exports = router;