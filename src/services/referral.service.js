const { User, ReferralConfig, Transaction } = require('../models');
const { ROLES, TRANSACTION_TYPE, TRANSACTION_STATUS } = require('../constants/enums');

/** Look up a user by their referral code. Returns null if the code doesn't
 * exist — callers should treat an invalid code as "no referrer", not an error,
 * since it's an optional field the person may have mistyped. */
async function resolveReferrer(code) {
  if (!code) return null;
  const trimmed = String(code).trim().toUpperCase();
  if (!trimmed) return null;
  return User.findOne({ referralCode: trimmed });
}

/** Which config field applies for a given (referrer role -> earner role) pair.
 * Returns null if this pair isn't part of the commission program (e.g. a Fan
 * referring anyone doesn't currently earn commission — nothing in the spec
 * covers that case). */
function pickPercentField(referrerRole, earnerRole) {
  if (referrerRole === ROLES.AGENCY && earnerRole === ROLES.AGENCY) return 'agentToAgentPercent';
  if (referrerRole === ROLES.AGENCY && (earnerRole === ROLES.BRAND || earnerRole === ROLES.CREATOR)) return 'agentToBrandOrCreatorPercent';
  if (referrerRole === ROLES.CREATOR && earnerRole === ROLES.CREATOR) return 'creatorToCreatorPercent';
  if (referrerRole === ROLES.CREATOR && earnerRole === ROLES.BRAND) return 'creatorToBrandPercent';
  return null;
}

/**
 * Call this whenever a user earns money (a session payment lands, a campaign
 * payout releases, etc.) — if that user was referred by someone, and the
 * (referrer role, earner role) pair is part of the commission program, this
 * credits the referrer's wallet and records a real Transaction so it shows up
 * in their wallet history.
 *
 * @param {string} earnerUserId - the User who just earned `grossAmount`
 * @param {number} grossAmount - in paise, the amount the earner was paid (before this cut)
 * @param {'Booking'|'Campaign'|'Session'|null} relatedModel
 * @param {string|null} relatedId
 * @returns {Promise<number>} the referral commission amount deducted, in paise (0 if none applied)
 */
async function creditReferralCommission(earnerUserId, grossAmount, relatedModel = null, relatedId = null) {
  const earner = await User.findById(earnerUserId);
  if (!earner || !earner.referredBy) return 0;

  const referrer = await User.findById(earner.referredBy);
  if (!referrer) return 0;

  const percentField = pickPercentField(referrer.role, earner.role);
  if (!percentField) return 0;

  const config = await ReferralConfig.getSingleton();
  const percent = config[percentField];
  if (!percent) return 0;

  const commission = Math.round((grossAmount * percent) / 100);
  if (commission <= 0) return 0;

  referrer.walletBalance += commission;
  await referrer.save();

  await Transaction.create({
    type: TRANSACTION_TYPE.REFERRAL_COMMISSION,
    status: TRANSACTION_STATUS.SUCCESS,
    from: earner._id,
    to: referrer._id,
    amount: grossAmount,
    referralCommission: commission,
    netAmount: commission,
    relatedModel,
    relatedId,
    notes: `Referral commission (${percent}%) for ${earner.name}'s earnings`,
  });

  return commission;
}

module.exports = { resolveReferrer, creditReferralCommission, pickPercentField };