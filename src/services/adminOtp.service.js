// File: src/services/adminOtp.service.js
const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiError = require('../utils/apiError');
const { sendEmail, escapeHtml } = require('./email.service');

// Admin 2-step login: after the right password, a 6-digit code goes to the
// admin's email. The code is stored hashed, works once, for 10 minutes,
// and 5 wrong tries kill it.

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const adminOtpSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    challenge: { type: String, required: true, unique: true }, // random id the panel sends back
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'adminotps' }
);
// Mongo removes expired codes on its own.
adminOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const AdminOtp = mongoose.models.AdminOtp || mongoose.model('AdminOtp', adminOtpSchema);

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Creates a code for [user], emails it and returns the challenge id. */
async function startChallenge(user) {
  // One live code per admin.
  await AdminOtp.deleteMany({ user: user._id });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const challenge = crypto.randomBytes(24).toString('hex');
  await AdminOtp.create({ user: user._id, challenge, codeHash: hash(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) });

  await sendEmail({
    to: user.email,
    subject: `${code} is your Fanitt admin login code`,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111">
      <p>Hi ${escapeHtml(user.name || 'there')},</p>
      <p>Your Fanitt admin login code is:</p>
      <p style="font-size:30px;font-weight:800;letter-spacing:6px;margin:16px 0">${code}</p>
      <p>It works once, for 10 minutes. If you didn’t just try to log in, change your password right away.</p>
    </div>`,
  });
  return challenge;
}

/** Checks the code. Returns the user id it belongs to. */
async function verifyChallenge(challenge, code) {
  if (!challenge || !code) throw ApiError.badRequest('Enter the 6-digit code');
  const doc = await AdminOtp.findOne({ challenge: String(challenge) });
  if (!doc || doc.expiresAt.getTime() < Date.now()) throw ApiError.unauthorized('This code has expired — log in again to get a new one');
  if (doc.attempts >= MAX_ATTEMPTS) {
    await doc.deleteOne();
    throw ApiError.unauthorized('Too many wrong codes — log in again to get a new one');
  }
  if (!safeEqual(doc.codeHash, hash(String(code).trim()))) {
    doc.attempts += 1;
    await doc.save();
    throw ApiError.unauthorized(`Wrong code — ${Math.max(0, MAX_ATTEMPTS - doc.attempts)} tries left`);
  }
  await doc.deleteOne(); // works once
  return doc.user;
}

module.exports = { startChallenge, verifyChallenge };