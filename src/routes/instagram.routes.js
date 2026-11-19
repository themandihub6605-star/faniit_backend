// File: src/routes/instagram.routes.js
const express = require('express');
const c = require('../controllers/instagram.controller');
const { protect } = require('../middlewares/auth.middleware');

const router = express.Router();

// Meta webhook verification (public). POST /webhook is wired in app.js
// before the JSON parser, because its signature is checked on the raw body.
router.get('/webhook', c.verifyWebhook);

// Instagram connect + Auto DM (fanitt.com/connect/instagram) — logged-in users.
router.get('/auth-url', protect, c.authUrl);
router.post('/connect', protect, c.connect);
router.delete('/connect', protect, c.disconnect);
router.get('/me', protect, c.me);
router.post('/refresh', protect, c.refresh);
router.get('/media', protect, c.media);
router.post('/rules', protect, c.createRule);
router.patch('/rules/:ruleId', protect, c.updateRule);
router.delete('/rules/:ruleId', protect, c.deleteRule);

module.exports = router;