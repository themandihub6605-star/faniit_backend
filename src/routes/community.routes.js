const express = require('express');

const router = express.Router();

const c = require('../controllers/community.controller');
const { protect, optionalAuth } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { uploadImage, uploadMedia } = require('../middlewares/upload.middleware');
const { ROLES } = require('../constants/enums');

const communityImages = uploadImage('fanitt/communities').fields([
  { name: 'icon', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
]);
const postMedia = uploadMedia('fanitt/community-posts').array('media', 5);

// Platform admin (before '/:slug' so they aren't read as a slug)
router.get('/admin/settings', protect, authorize(ROLES.ADMIN), c.adminGetSettings);
router.patch('/admin/settings', protect, authorize(ROLES.ADMIN), c.adminUpdateSettings);
router.get('/admin/payments', protect, authorize(ROLES.ADMIN), c.adminListPayments);
router.get('/admin/all', protect, authorize(ROLES.ADMIN), c.adminListCommunities);
router.patch('/admin/:id', protect, authorize(ROLES.ADMIN), c.adminUpdateCommunity);
router.delete('/admin/:id', protect, authorize(ROLES.ADMIN), c.deleteCommunity);

// Posts, comments (addressed by their own ids)
router.get('/posts/:postId', optionalAuth, c.getPost);
router.patch('/posts/:postId', protect, c.updatePost);
router.delete('/posts/:postId', protect, c.deletePost);
router.post('/posts/:postId/like', protect, c.togglePostLike);
router.post('/posts/:postId/pin', protect, c.togglePin);
router.post('/posts/:postId/free', protect, c.toggleFree);
router.post('/posts/:postId/vote', protect, c.votePoll);
router.get('/posts/:postId/comments', optionalAuth, c.listComments);
router.post('/posts/:postId/comments', protect, c.addComment);
router.delete('/comments/:commentId', protect, c.deleteComment);
router.post('/comments/:commentId/like', protect, c.toggleCommentLike);

// Communities
router.get('/', optionalAuth, c.listCommunities);
router.get('/me', protect, c.getMyCommunities);
router.get('/config', protect, c.getConfig);
router.post('/', protect, communityImages, c.createCommunity);
router.patch('/:id', protect, communityImages, c.updateCommunity);
router.delete('/:id', protect, c.deleteCommunity);
router.post('/:id/join', protect, c.toggleMembership);
router.post('/:id/checkout', protect, c.checkout);
router.patch('/:id/me', protect, c.updateMySettings);

// Members
router.get('/:id/members', optionalAuth, c.listMembers);
router.patch('/:id/members/:userId', protect, c.manageMember);

// Feed
router.get('/:id/posts', optionalAuth, c.listPosts);
router.post('/:id/posts', protect, postMedia, c.createPost);

// Chat
router.get('/:id/chat', protect, c.getChat);
router.post('/:id/chat', protect, c.sendChat);
router.post('/:id/chat/read', protect, c.markChatRead);
router.delete('/:id/chat/:messageId', protect, c.deleteChatMessage);

// Detail — by slug or id (last, so it doesn't swallow the routes above)
router.get('/:slug', optionalAuth, c.getCommunity);

module.exports = router;