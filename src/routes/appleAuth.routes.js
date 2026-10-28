// File: src/routes/appleAuth.routes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { appleAuth } = require('../controllers/appleAuth.controller');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
});

router.post('/', limiter, appleAuth);

module.exports = router;