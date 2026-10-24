// File: src/routes/auth.routes.js
const express = require('express');
const router = express.Router();

const {
  register,
  login,
  verifyAdminCode,
  refresh,
  logout,
  getMe,
  forgotPassword,
  resetPassword,
  googleAuth,
  upgradeRole,
  completeOnboarding,
} = require('../controllers/auth.controller');
const { protect } = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { authLimiter, loginPerEmailLimiter, passwordResetLimiter, otpLimiter, refreshLimiter } = require('../middlewares/rateLimiter.middleware');
const { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } = require('../validators/auth.validator');

router.post('/register', authLimiter, validate(registerSchema), register);
router.post('/login', authLimiter, loginPerEmailLimiter, validate(loginSchema), login);
router.post('/admin/verify-code', otpLimiter, verifyAdminCode);
router.post('/google', authLimiter, googleAuth);
router.post('/refresh', refreshLimiter, refresh);
router.post('/logout', logout);
router.get('/me', protect, getMe);
router.post('/forgot-password', passwordResetLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), resetPassword);
router.post('/upgrade-role', protect, upgradeRole);
router.post('/complete-onboarding', protect, completeOnboarding);

module.exports = router;