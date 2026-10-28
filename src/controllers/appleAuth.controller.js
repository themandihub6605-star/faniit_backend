// File: src/controllers/appleAuth.controller.js
const crypto = require('crypto');
const { User, CreatorProfile, BrandProfile, AgencyProfile } = require('../models');
const { generateAccessToken, generateRefreshToken } = require('../utils/generateToken');
const generateSlug = require('../utils/slugify');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { ROLES } = require('../constants/enums');
const { resolveReferrer } = require('../services/referral.service');

// Sign in with Apple (iPhone). Same idea as Google: the app signs in with
// Firebase (Apple provider) and sends the Firebase ID token here.
//
//   POST /auth/apple { idToken, name?, role?, referralCode? }
//
// Apple only gives the person's name the very first time, so the app sends
// it along. The email can be a private relay (…@privaterelay.appleid.com);
// emails sent there reach the person normally.

const SIGNUP_ROLES = [ROLES.FAN, ROLES.CREATOR, ROLES.BRAND, ROLES.AGENCY];

// Accept 'apple' as a sign-in method without touching User.model.js.
try {
  const path = User.schema.path('authProvider');
  if (path && Array.isArray(path.enumValues) && !path.enumValues.includes('apple')) path.enum('apple');
} catch {
  // Older model without authProvider — nothing to do.
}

function issueTokens(res, user) {
  const accessToken = generateAccessToken(user._id, user.role);
  const refreshToken = generateRefreshToken(user._id);
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  return { accessToken, refreshToken };
}

async function getProfileStatus(user) {
  const Model = user.role === ROLES.CREATOR ? CreatorProfile : user.role === ROLES.BRAND ? BrandProfile : user.role === ROLES.AGENCY ? AgencyProfile : null;
  if (!Model) return null;
  const p = await Model.findOne({ user: user._id }).select('verificationStatus');
  return p?.verificationStatus || null;
}

const cleanName = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 60);

exports.appleAuth = catchAsync(async (req, res) => {
  const { idToken, role: requestedRole, referralCode } = req.body || {};
  if (!idToken) throw ApiError.badRequest('Missing Apple sign-in token');

  const { getFirebaseAdmin } = require('../config/firebase');
  let decoded;
  try {
    decoded = await getFirebaseAdmin().auth().verifyIdToken(idToken);
  } catch {
    throw ApiError.unauthorized('Apple sign-in expired — please try again');
  }
  if (decoded.firebase?.sign_in_provider !== 'apple.com') throw ApiError.badRequest('This is not an Apple sign-in');

  const email = String(decoded.email || '').toLowerCase();
  if (!email) throw ApiError.badRequest('Apple didn’t share an email. Please allow email when you sign in with Apple.');

  let user = await User.findOne({ email });
  const isNewUser = !user;

  if (user) {
    if (user.isActive === false) {
      throw new ApiError(403, 'Your account deletion request is under review. Once it is approved you can sign up again with this email.', [], 'ACCOUNT_DELETION_PENDING');
    }
    if (user.isSuspended) throw ApiError.forbidden('Your account has been suspended. Contact support.');
    if (user.role === ROLES.ADMIN) throw ApiError.forbidden('Admin accounts sign in with email and password.');
    user.lastLoginAt = new Date();
    await user.save();
  } else {
    const role = SIGNUP_ROLES.includes(requestedRole) ? requestedRole : ROLES.FAN;
    const relay = email.endsWith('@privaterelay.appleid.com');
    const finalName = cleanName(req.body?.name) || cleanName(decoded.name) || (relay ? 'Fanitt user' : email.split('@')[0]);
    const referrer = referralCode ? await resolveReferrer(referralCode) : null;

    user = await User.create({
      name: finalName,
      email,
      password: crypto.randomBytes(24).toString('hex'),
      authProvider: 'apple',
      role,
      roles: [role],
      referredBy: referrer?._id || null,
    });

    if (role === ROLES.CREATOR) {
      await CreatorProfile.create({ user: user._id, slug: generateSlug(finalName) });
    } else if (role === ROLES.BRAND) {
      await BrandProfile.create({ user: user._id, companyName: finalName, slug: generateSlug(finalName) });
    } else if (role === ROLES.AGENCY) {
      await AgencyProfile.create({ user: user._id, agencyName: finalName, referralCode: user.referralCode });
    }
  }

  const { accessToken, refreshToken } = issueTokens(res, user);
  const profileStatus = await getProfileStatus(user);
  return new ApiResponse(
    200,
    { user: { ...user.toSafeObject(), profileStatus }, accessToken, refreshToken, isNewUser, profileStatus },
    'Signed in with Apple',
  ).send(res);
});