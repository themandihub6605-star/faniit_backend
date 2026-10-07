const { User, CreatorProfile, BrandProfile, AgencyProfile } = require('../models');
const { ROLES, VERIFICATION_STATUS } = require('../constants/enums');

// The same required fields the app asks for on "Edit profile".
// Each entry: [label, isMissing(user, profile)].
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const emptyList = (v) => !Array.isArray(v) || v.length === 0;

const REQUIRED = {
  [ROLES.CREATOR]: [
    ['Profile photo', (u) => blank(u.avatarUrl)],
    ['Phone', (u) => blank(u.phone)],
    ['Headline', (u, p) => blank(p?.title)],
    ['Category', (u, p) => !p?.category],
    ['Bio', (u, p) => blank(p?.bio)],
    ['City', (u, p) => blank(p?.location)],
    ['Skills', (u, p) => emptyList(p?.skills)],
    ['Languages', (u, p) => emptyList(p?.languages)],
    ['Response time', (u, p) => blank(p?.responseTime)],
    ['Instagram', (u, p) => blank(p?.socials?.instagram)],
  ],
  [ROLES.BRAND]: [
    ['Logo', (u, p) => blank(p?.logoUrl)],
    ['Phone', (u) => blank(u.phone)],
    ['Tagline', (u, p) => blank(p?.tagline)],
    ['Industry', (u, p) => blank(p?.industry)],
    ['About', (u, p) => blank(p?.about)],
    ['Headquarters', (u, p) => blank(p?.location)],
    ['Founded year', (u, p) => !p?.foundedYear],
    ['Team size', (u, p) => blank(p?.companySize)],
    ['What you offer', (u, p) => emptyList(p?.whatWeOffer)],
    ['Instagram', (u, p) => blank(p?.socials?.instagram)],
  ],
  [ROLES.AGENCY]: [
    ['Owner name', (u, p) => blank(p?.ownerName)],
    ['Mobile', (u, p) => blank(p?.mobile)],
    ['City', (u, p) => blank(p?.city)],
    ['State', (u, p) => blank(p?.state)],
    ['GST number', (u, p) => blank(p?.gstNumber)],
    ['ID proof', (u, p) => blank(p?.documentUrl)],
  ],
};

const PROFILE_MODEL = {
  [ROLES.CREATOR]: CreatorProfile,
  [ROLES.BRAND]: BrandProfile,
  [ROLES.AGENCY]: AgencyProfile,
};

/** Roles that have a profile the team reviews. Fans and admins don't. */
const hasReviewedProfile = (role) => Boolean(PROFILE_MODEL[role]);

function missingFields(user, profile) {
  const rules = REQUIRED[user.role];
  if (!rules) return [];
  if (!profile) return rules.map(([label]) => label);
  return rules.filter(([, isMissing]) => isMissing(user, profile)).map(([label]) => label);
}

/** { status, missing, percent, rejectionReason, profileId } for each user,
 * keyed by user id — for one page of the admin user list. */
async function summarize(users) {
  const byRole = {};
  for (const u of users) {
    if (hasReviewedProfile(u.role)) (byRole[u.role] ||= []).push(u._id);
  }
  const profiles = new Map();
  await Promise.all(
    Object.entries(byRole).map(async ([role, ids]) => {
      const rows = await PROFILE_MODEL[role].find({ user: { $in: ids } }).lean();
      for (const p of rows) profiles.set(String(p.user), p);
    })
  );

  const out = {};
  for (const u of users) {
    if (!hasReviewedProfile(u.role)) {
      out[String(u._id)] = null;
      continue;
    }
    const p = profiles.get(String(u._id)) || null;
    const missing = missingFields(u, p);
    const total = REQUIRED[u.role].length;
    out[String(u._id)] = {
      profileId: p?._id || null,
      status: p?.verificationStatus || VERIFICATION_STATUS.UNVERIFIED,
      rejectionReason: p?.rejectionReason || '',
      missing,
      percent: Math.round(((total - missing.length) / total) * 100),
    };
  }
  return out;
}

// ---------- Mongo filters for "incomplete" ----------

const PROFILE_GAPS = {
  [ROLES.CREATOR]: [
    { title: { $in: ['', null] } },
    { category: null },
    { bio: { $in: ['', null] } },
    { location: { $in: ['', null] } },
    { skills: { $size: 0 } },
    { languages: { $size: 0 } },
    { responseTime: { $in: ['', null] } },
    { 'socials.instagram': { $in: ['', null] } },
  ],
  [ROLES.BRAND]: [
    { logoUrl: { $in: ['', null] } },
    { tagline: { $in: ['', null] } },
    { industry: { $in: ['', null] } },
    { about: { $in: ['', null] } },
    { location: { $in: ['', null] } },
    { foundedYear: null },
    { companySize: { $in: ['', null] } },
    { whatWeOffer: { $size: 0 } },
    { 'socials.instagram': { $in: ['', null] } },
  ],
  [ROLES.AGENCY]: [
    { ownerName: { $in: ['', null] } },
    { mobile: { $in: ['', null] } },
    { city: { $in: ['', null] } },
    { state: { $in: ['', null] } },
    { gstNumber: { $in: ['', null] } },
    { documentUrl: { $in: ['', null] } },
  ],
};

const noValue = (field) => ({ $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }] });

/** User ids (creator / brand / agency) with at least one required field empty.
 * Pass a role to limit it. */
async function incompleteUserIds(role) {
  const roles = role ? [role].filter(hasReviewedProfile) : Object.keys(PROFILE_MODEL);
  const ids = new Set();
  await Promise.all(
    roles.map(async (r) => {
      const fromProfile = await PROFILE_MODEL[r].find({ $or: PROFILE_GAPS[r] }).distinct('user');
      fromProfile.forEach((id) => ids.add(String(id)));

      // Account-level fields (photo / phone), and accounts with no profile at all.
      const accountGaps = [];
      if (r === ROLES.CREATOR) accountGaps.push(noValue('avatarUrl'), noValue('phone'));
      if (r === ROLES.BRAND) accountGaps.push(noValue('phone'));
      if (accountGaps.length) {
        const fromUser = await User.find({ role: r, $or: accountGaps }).distinct('_id');
        fromUser.forEach((id) => ids.add(String(id)));
      }
      const withProfile = await PROFILE_MODEL[r].distinct('user');
      const noProfile = await User.find({ role: r, _id: { $nin: withProfile } }).distinct('_id');
      noProfile.forEach((id) => ids.add(String(id)));
    })
  );
  return [...ids];
}

/** User ids whose profile is in one review status. */
async function userIdsWithStatus(status, role) {
  const roles = role ? [role].filter(hasReviewedProfile) : Object.keys(PROFILE_MODEL);
  const lists = await Promise.all(roles.map((r) => PROFILE_MODEL[r].find({ verificationStatus: status }).distinct('user')));
  return lists.flat().map(String);
}

module.exports = { PROFILE_MODEL, REQUIRED, hasReviewedProfile, missingFields, summarize, incompleteUserIds, userIdsWithStatus };