const express = require('express');
const router = express.Router();

const { createPost, getCreatorPosts, getFeed, toggleLike, deletePost } = require('../controllers/post.controller');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { uploadMedia } = require('../middlewares/upload.middleware');
const { ROLES } = require('../constants/enums');

router.get('/feed', getFeed);
router.get('/creator/:creatorId', getCreatorPosts);
router.post('/', protect, authorize(ROLES.CREATOR), uploadMedia('fanitt/creator-posts').single('media'), createPost);
router.post('/:id/like', protect, toggleLike);
router.delete('/:id', protect, deletePost);

module.exports = router;