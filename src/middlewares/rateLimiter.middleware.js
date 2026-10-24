// File: src/middlewares/rateLimiter.middleware.js
const rateLimit = require('express-rate-limit');

// Every limit answers in the same shape as the rest of the API.
const message = (text) => ({ success: false, message: text, errors: [], errorCode: 'RATE_LIMITED' });

/** Login / register / Google sign-in — per IP. */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: message('Too many attempts. Please try again in 15 minutes.'),
  standardHeaders: true,
  legacyHeaders: false,
});

/** Wrong passwords for ONE email, from any IP — stops slow password guessing. */
const loginPerEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyGenerator: (req) => `login:${String(req.body?.email || '').trim().toLowerCase() || req.ip}`,
  skipSuccessfulRequests: true, // only failed logins count
  message: message('Too many wrong passwords for this account. Try again in 15 minutes or reset your password.'),
  standardHeaders: true,
  legacyHeaders: false,
});

/** Forgot-password / reset — emails cost money and can be abused for spam. */
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: (req) => `reset:${String(req.body?.email || '').trim().toLowerCase() || req.ip}`,
  message: message('Too many reset requests. Please try again in an hour.'),
  standardHeaders: true,
  legacyHeaders: false,
});

/** One-time codes (admin 2-step login). */
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: message('Too many code attempts. Please try again in 15 minutes.'),
  standardHeaders: true,
  legacyHeaders: false,
});

/** Token refresh — the app refreshes now and then, not hundreds of times. */
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: message('Too many requests. Please slow down.'),
  standardHeaders: true,
  legacyHeaders: false,
});

/** Starting a payment / checkout / withdrawal — per signed-in user (or IP). */
const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 30,
  keyGenerator: (req) => (req.user?._id ? `pay:${req.user._id}` : `pay:${req.ip}`),
  message: message('Too many payment attempts. Please wait a few minutes and try again.'),
  standardHeaders: true,
  legacyHeaders: false,
});

/** Everything else, per IP. */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: message('Too many requests. Please slow down.'),
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { authLimiter, loginPerEmailLimiter, passwordResetLimiter, otpLimiter, refreshLimiter, paymentLimiter, generalLimiter };