const express = require('express');
const router = express.Router();

const {
  listConversations,
  startConversation,
  startConversationForApplication,
  getConversationForApplication,
  getMessages,
  sendMessage,
} = require('../controllers/chat.controller');
const { protect } = require('../middlewares/auth.middleware');

router.get('/conversations', protect, listConversations);
router.post('/conversations', protect, startConversation);

// Proposal-scoped messaging — the only way a creator and brand can talk
// to each other (see chat.controller.js for the full explanation).
router.post('/applications/:applicationId/start', protect, startConversationForApplication);
router.get('/applications/:applicationId', protect, getConversationForApplication);

router.get('/conversations/:id/messages', protect, getMessages);
router.post('/conversations/:id/messages', protect, sendMessage);

module.exports = router;