const express = require('express');
const router = express.Router();

const { createPost, getCreatorPosts, getMyPosts, getFeed, toggleLike, updatePost, deletePost } = require('../controllers/post.controller');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { uploadMedia } = require('../middlewares/upload.middleware');
const { ROLES } = require('../constants/enums');

router.get('/feed', getFeed);
router.get('/me', protect, authorize(ROLES.CREATOR), getMyPosts);
router.get('/creator/:creatorId', getCreatorPosts);
router.post('/', protect, authorize(ROLES.CREATOR), uploadMedia('fanitt/creator-posts').array('media', 5), createPost);
router.post('/:id/like', protect, toggleLike);
router.patch('/:id', protect, updatePost);
router.delete('/:id', protect, deletePost);

module.exports = router;