// File: src/routes/contact.routes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/contact.controller');

const router = express.Router();

// Website contact form — 5 messages per hour from one IP.
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many messages. Please try again in an hour, or email info@fanitt.com.', errors: [], errorCode: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Mounted at /api/contact — public.
router.post('/', contactLimiter, ctrl.createMessage);

module.exports = router;