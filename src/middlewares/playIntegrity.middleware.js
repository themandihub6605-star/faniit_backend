// File: src/middlewares/playIntegrity.middleware.js
const crypto = require('crypto');
const env = require('../config/env');

// Google Play Integrity — "is this request from the real Fanitt app,
// installed from Play, on a genuine phone?"
//
// The Android app sends a token in the `X-Integrity-Token` header on
// sensitive requests (login, sign-up, payments, withdrawals, calls).
// We ask Google to decode it and check the verdict.
//
// PLAY_INTEGRITY_MODE (in .env):
//   off     — nothing is checked (default)
//   log     — tokens are checked and the result is logged; nobody is blocked
//   enforce — sensitive requests from outside a browser must carry a valid token
//
// Browsers (website, admin panel) can't get a Play token, so requests that
// come with an allowed Origin header are never blocked.
//
// Uses the Firebase service account (FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).
// In Google Play Console → App integrity → link the same Google Cloud project,
// and enable "Google Play Integrity API" in that project.

const SENSITIVE = [
  /^\/api\/auth\/(login|register|google)$/,
  /^\/api\/payments(\/|$)/,
  /^\/api\/subscriptions\/checkout/,
  /^\/api\/wallet\/withdraw/,
  /^\/api\/(milestones|campaigns)\/[^/]+\/(fund|escrow|verify)/,
  /^\/api\/(donations|bookings)(\/|$)/,
  /^\/api\/store\/.*\/checkout(\/|$)/,
  /^\/api\/store\/shop\/checkout/,
  /^\/api\/store\/stores\/[^/]+\/calls$/,
  /^\/api\/store\/lives\/[^/]+\/(checkout|join)$/,
  /^\/api\/store\/fanbox$/,
];

const TOKEN_MAX_AGE_MS = 10 * 60 * 1000;
const cache = new Map(); // tokenHash -> { ok, reason, at }

let authClient = null;
async function getClient() {
  if (authClient) return authClient;
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({
    credentials: {
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/playintegrity'],
  });
  authClient = await auth.getClient();
  return authClient;
}

/** Asks Google to decode the token and checks the verdict. */
async function verifyToken(token) {
  const key = crypto.createHash('sha256').update(token).digest('hex');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TOKEN_MAX_AGE_MS) return hit;

  let result;
  try {
    const client = await getClient();
    const pkg = env.security.androidPackageName;
    const res = await client.request({
      url: `https://playintegrity.googleapis.com/v1/${encodeURIComponent(pkg)}:decodeIntegrityToken`,
      method: 'POST',
      data: { integrity_token: token },
    });
    const p = res.data?.tokenPayloadExternal || {};
    const details = p.requestDetails || {};
    const appVerdict = p.appIntegrity?.appRecognitionVerdict;
    const device = p.deviceIntegrity?.deviceRecognitionVerdict || [];
    const issuedAt = Number(details.timestampMillis || 0);

    if (details.requestPackageName !== pkg) result = { ok: false, reason: 'wrong_package' };
    else if (appVerdict !== 'PLAY_RECOGNIZED') result = { ok: false, reason: `app_${appVerdict || 'unknown'}` };
    else if (!device.includes('MEETS_DEVICE_INTEGRITY')) result = { ok: false, reason: 'device_not_trusted' };
    else if (issuedAt && Date.now() - issuedAt > TOKEN_MAX_AGE_MS) result = { ok: false, reason: 'token_too_old' };
    else result = { ok: true, reason: 'ok' };
  } catch (err) {
    result = { ok: false, reason: `decode_failed:${err.response?.status || err.message}` };
  }
  result.at = Date.now();
  cache.set(key, result);
  if (cache.size > 5000) cache.delete(cache.keys().next().value); // keep it small
  return result;
}

function isBrowserRequest(req) {
  const origin = req.headers.origin;
  return Boolean(origin && env.clientUrls.includes(origin));
}

async function playIntegrity(req, res, next) {
  const mode = env.security.playIntegrityMode;
  if (mode !== 'log' && mode !== 'enforce') return next();
  if (req.method === 'GET' || req.method === 'OPTIONS') return next();

  const path = req.originalUrl.split('?')[0];
  if (!SENSITIVE.some((re) => re.test(path))) return next();
  if (isBrowserRequest(req)) return next();

  const token = req.headers['x-integrity-token'];
  if (!token) {
    console.warn('[play-integrity]', mode, 'missing token', req.method, path);
    if (mode === 'enforce') {
      return res.status(403).json({ success: false, message: 'Please update Fanitt from the Play Store to continue.', errors: [], errorCode: 'INTEGRITY_REQUIRED' });
    }
    return next();
  }

  const verdict = await verifyToken(String(token));
  if (!verdict.ok) {
    console.warn('[play-integrity]', mode, 'failed', verdict.reason, req.method, path);
    if (mode === 'enforce') {
      return res.status(403).json({ success: false, message: 'This request could not be verified. Please use the Fanitt app from the Play Store.', errors: [], errorCode: 'INTEGRITY_FAILED' });
    }
  }
  return next();
}

module.exports = { playIntegrity };