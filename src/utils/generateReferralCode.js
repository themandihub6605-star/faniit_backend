// Every referral code on Fanitt is exactly 8 characters:
//   2-letter role prefix + 6 random characters, e.g. CRK7F3QX
//   CR = creator, BR = brand, AG = agency, FN = fan, AD = admin
// The random part skips 0/O/1/I so codes are easy to read aloud and type.

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RANDOM_LENGTH = 6;
const REFERRAL_CODE_LENGTH = 8;

const ROLE_PREFIX = {
  creator: 'CR',
  brand: 'BR',
  agency: 'AG',
  fan: 'FN',
  admin: 'AD',
};

/** What users may type: 2 letters + 6 letters/digits (case-insensitive). */
const REFERRAL_CODE_PATTERN = /^[A-Z]{2}[A-Z0-9]{6}$/;

function referralPrefixFor(role) {
  return ROLE_PREFIX[role] || ROLE_PREFIX.fan;
}

/** One random candidate for the given role. Callers check uniqueness. */
function generateReferralCode(role = 'fan') {
  let code = referralPrefixFor(role);
  for (let i = 0; i < RANDOM_LENGTH; i += 1) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function normalizeReferralCode(code) {
  return String(code || '').trim().toUpperCase();
}

function isValidReferralCode(code) {
  return REFERRAL_CODE_PATTERN.test(normalizeReferralCode(code));
}

module.exports = generateReferralCode;
module.exports.generateReferralCode = generateReferralCode;
module.exports.referralPrefixFor = referralPrefixFor;
module.exports.normalizeReferralCode = normalizeReferralCode;
module.exports.isValidReferralCode = isValidReferralCode;
module.exports.REFERRAL_CODE_LENGTH = REFERRAL_CODE_LENGTH;
module.exports.REFERRAL_CODE_PATTERN = REFERRAL_CODE_PATTERN;