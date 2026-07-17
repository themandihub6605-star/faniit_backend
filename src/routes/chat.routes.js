const express = require('express');
const router = express.Router();

const { listConversations, startConversation, getMessages, sendMessage } = require('../controllers/chat.controller');
const { protect } = require('../middlewares/auth.middleware');

router.get('/conversations', protect, listConversations);
router.post('/conversations', protect, startConversation);
router.get('/conversations/:id/messages', protect, getMessages);
router.post('/conversations/:id/messages', protect, sendMessage);

module.exports = router;