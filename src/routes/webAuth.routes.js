// File: src/routes/webAuth.routes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const c = require('../controllers/webAuth.controller');

// 10 tries per 15 minutes per IP — stops code guessing and email spam.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
});

router.post('/send-code', limiter, c.sendCode);
router.post('/verify', limiter, c.verify);

module.exports = router;