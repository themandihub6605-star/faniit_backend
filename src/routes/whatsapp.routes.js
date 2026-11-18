// File: src/routes/whatsapp.routes.js
const express = require('express');
const { verifyWebhook, receiveWebhook } = require('../controllers/whatsapp.controller');
const { connect, me, send, templates, createTemplate, disconnect } = require('../controllers/whatsappConnect.controller');
const { protect } = require('../middlewares/auth.middleware');

const router = express.Router();

// Meta webhook (public — Meta calls these).
router.get('/webhook', verifyWebhook);
router.post('/webhook', receiveWebhook);

// Connect a WhatsApp Business number (fanitt.com/connect/whatsapp) — logged-in users.
router.post('/connect', protect, connect);
router.get('/connect/me', protect, me);
router.post('/connect/send', protect, send);
router.get('/connect/templates', protect, templates);
router.post('/connect/templates', protect, createTemplate);
router.delete('/connect', protect, disconnect);

module.exports = router;