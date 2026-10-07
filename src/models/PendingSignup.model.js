const mongoose = require('mongoose');

/**
 * A sign-up waiting for its email code. No User exists until the code is
 * confirmed, so fake / mistyped emails never become accounts.
 * Rows remove themselves an hour after the last code was sent.
 */
const pendingSignupSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    otpHash: { type: String, required: true },
    expiresAt: { type: Date, required: true }, // code valid for 10 minutes
    attempts: { type: Number, default: 0 }, // wrong tries on the current code
    lastSentAt: { type: Date, required: true },
    windowStart: { type: Date, required: true }, // start of the 1-hour send window
    sentInWindow: { type: Number, default: 0 },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true }
);

pendingSignupSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PendingSignup', pendingSignupSchema);