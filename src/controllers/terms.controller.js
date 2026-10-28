// File: src/controllers/terms.controller.js
const { TermsAcceptance } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');

// Terms of Use acceptance.
//
//   GET  /terms/status   { accepted, version, acceptedVersion, acceptedAt }
//   POST /terms/accept   { version?, platform? }
//
// Change TERMS_VERSION in .env (e.g. 2026-11) when the Terms change a lot —
// everyone is then asked to agree again on their next app open.

const currentVersion = () => process.env.TERMS_VERSION || '2026-10';

exports.status = catchAsync(async (req, res) => {
  const row = await TermsAcceptance.findOne({ user: req.user._id }).lean();
  const version = currentVersion();
  return new ApiResponse(200, {
    accepted: Boolean(row && row.version === version),
    version,
    acceptedVersion: row ? row.version : null,
    acceptedAt: row ? row.acceptedAt : null,
  }).send(res);
});

exports.accept = catchAsync(async (req, res) => {
  const version = currentVersion();
  const platform = String((req.body && req.body.platform) || '').slice(0, 20);
  await TermsAcceptance.updateOne(
    { user: req.user._id },
    { $set: { version, acceptedAt: new Date(), platform } },
    { upsert: true },
  );
  return new ApiResponse(200, { accepted: true, version }, 'Thanks for agreeing to the Terms').send(res);
});