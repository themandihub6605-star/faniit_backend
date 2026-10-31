// File: src/middlewares/rateLimiter.middleware.js
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { verifyAccessToken } = require('../utils/generateToken');

// Every limit answers in the same shape as the rest of the API.
const message = (text) => ({ success: false, message: text, errors: [], errorCode: 'RATE_LIMITED' });

// WHY KEYS MATTER: limits used to count per IP only. When the proxy in front
// (nginx / Cloudflare) doesn't pass the real IP, EVERY user looks like the
// same IP — all of them share one small quota and the whole app shows
// "Too many requests" at once. Now:
//   • signed-in requests count per USER (from their login token)
//   • sign-in / codes count per IP + email, so one person can't lock others out
//   • only anonymous requests fall back to the IP

/** Signed-in user's id from the Bearer token, or null. Never throws. */
function userIdFrom(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return String(verifyAccessToken(header.slice(7)).id || '') || null;
  } catch {
    return null;
  }
}

/** Same as userIdFrom, worked out once per request. */
function cachedUserId(req) {
  if (req.rateLimitUserId === undefined) req.rateLimitUserId = userIdFrom(req);
  return req.rateLimitUserId;
}

const emailOf = (req) => String(req.body?.email || '').trim().toLowerCase();
const short = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);

const common = { standardHeaders: true, legacyHeaders: false };

/** Login / register / Google sign-in — per IP + email (or Google token). */
const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  keyGenerator: (req) => {
    const who = emailOf(req) || (req.body?.idToken ? short(req.body.idToken) : '');
    return `auth:${req.ip}:${who}`;
  },
  message: message('Too many attempts. Please try again in 15 minutes.'),
});

/** Wrong passwords for ONE email, from any IP — stops slow password guessing. */
const loginPerEmailLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyGenerator: (req) => `login:${emailOf(req) || req.ip}`,
  skipSuccessfulRequests: true, // only failed logins count
  message: message('Too many wrong passwords for this account. Try again in 15 minutes or reset your password.'),
});

/** Forgot-password / reset — emails cost money and can be abused for spam. */
const passwordResetLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: (req) => `reset:${emailOf(req) || req.ip}`,
  message: message('Too many reset requests. Please try again in an hour.'),
});

/** One-time codes (sign-up, forgot password, admin 2-step) — per IP + email. */
const otpLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 15,
  keyGenerator: (req) => `otp:${req.ip}:${emailOf(req)}`,
  message: message('Too many code attempts. Please try again in 15 minutes.'),
});

/** Token refresh — per refresh token (each phone has its own), else IP. */
const refreshLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => {
    const token = req.body?.refreshToken || req.cookies?.refreshToken;
    return token ? `refresh:${short(token)}` : `refresh:${req.ip}`;
  },
  message: message('Too many requests. Please slow down.'),
});

/** Starting a payment / checkout / withdrawal — per signed-in user (or IP). */
const paymentLimiter = rateLimit({
  ...common,
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 30,
  keyGenerator: (req) => {
    const id = req.user?._id ? String(req.user._id) : userIdFrom(req);
    return id ? `pay:${id}` : `pay:${req.ip}`;
  },
  message: message('Too many payment attempts. Please wait a few minutes and try again.'),
});

/**
 * Everything else. Signed-in: per user, generous (a busy user scrolling the
 * feed, opening stories and reels makes a lot of calls). Guests: per IP.
 */
const generalLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: (req) => (cachedUserId(req) ? 1500 : 600),
  keyGenerator: (req) => {
    const id = cachedUserId(req);
    return id ? `user:${id}` : `ip:${req.ip}`;
  },
  // Health checks and uploaded files never count.
  skip: (req) => req.path === '/api/health' || req.path.startsWith('/uploads/'),
  message: message('Too many requests. Please wait a minute and try again.'),
});

module.exports = { authLimiter, loginPerEmailLimiter, passwordResetLimiter, otpLimiter, refreshLimiter, paymentLimiter, generalLimiter };