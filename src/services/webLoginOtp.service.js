// File: src/services/webLoginOtp.service.js
const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiError = require('../utils/apiError');
const { sendEmail, escapeHtml } = require('./email.service');

// Website login with a 6-digit email code (no password). Works for every
// account — also people who signed up with Google in the app. The code is
// stored hashed, works once, for 10 minutes; 5 wrong tries kill it.

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_AFTER_MS = 45 * 1000;
const MAX_ATTEMPTS = 5;

const webLoginCodeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    challenge: { type: String, required: true, unique: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'webloginCodes' },
);
webLoginCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const WebLoginCode = mongoose.models.WebLoginCode || mongoose.model('WebLoginCode', webLoginCodeSchema);

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Emails a code to [user]. Returns { challenge, resendInSeconds }. */
async function start(user) {
  const last = await WebLoginCode.findOne({ user: user._id }).sort({ createdAt: -1 }).lean();
  if (last && Date.now() - new Date(last.createdAt).getTime() < RESEND_AFTER_MS) {
    const wait = Math.ceil((RESEND_AFTER_MS - (Date.now() - new Date(last.createdAt).getTime())) / 1000);
    throw ApiError.badRequest(`Please wait ${wait}s before asking for a new code`, 'OTP_RESEND_WAIT');
  }

  await WebLoginCode.deleteMany({ user: user._id }); // one live code per person
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const challenge = crypto.randomBytes(24).toString('hex');
  await WebLoginCode.create({ user: user._id, challenge, codeHash: hash(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) });

  await sendEmail({
    to: user.email,
    subject: `${code} is your Fanitt login code`,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111;line-height:1.5">
      <p>Hi ${escapeHtml(user.name || 'there')},</p>
      <p>Use this code to log in to Fanitt on the web:</p>
      <p style="font-size:32px;font-weight:800;letter-spacing:8px;margin:18px 0;color:#F4511E">${code}</p>
      <p>It works once, for 10 minutes. Never share it with anyone. If you didn’t try to log in, you can ignore this email.</p>
    </div>`,
  });
  return { challenge, resendInSeconds: Math.round(RESEND_AFTER_MS / 1000) };
}

/** Checks the code. Returns the user id it belongs to. */
async function verify(challenge, code) {
  if (!challenge || !code) throw ApiError.badRequest('Enter the 6-digit code');
  const doc = await WebLoginCode.findOne({ challenge: String(challenge) });
  if (!doc || doc.expiresAt.getTime() < Date.now()) throw ApiError.unauthorized('This code has expired — ask for a new one');
  if (doc.attempts >= MAX_ATTEMPTS) {
    await doc.deleteOne();
    throw ApiError.unauthorized('Too many wrong codes — ask for a new one');
  }
  if (!safeEqual(doc.codeHash, hash(String(code).trim()))) {
    doc.attempts += 1;
    await doc.save();
    throw ApiError.unauthorized(`Wrong code — ${Math.max(0, MAX_ATTEMPTS - doc.attempts)} tries left`);
  }
  await doc.deleteOne();
  return doc.user;
}

module.exports = { start, verify };