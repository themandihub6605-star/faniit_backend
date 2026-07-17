const express = require('express');
const router = express.Router();

const { getMyNotifications, markAsRead, markAllAsRead } = require('../controllers/notification.controller');
const { protect } = require('../middlewares/auth.middleware');

router.get('/me', protect, getMyNotifications);
router.patch('/:id/read', protect, markAsRead);
router.patch('/read-all', protect, markAllAsRead);

module.exports = router;
