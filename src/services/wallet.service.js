const { User, CreatorProfile, AgencyProfile, SiteSettings } = require('../models');
const env = require('../config/env');
const { creditReferralCommission } = require('./referral.service');

/**
 * Splits a gross amount into agency commission (if the creator is under an
 * agency), referral commission (if the creator was referred by someone
 * under the referral program), and the creator's wallet credit. All
 * amounts in paise.
 *
 * IMPORTANT CHANGE: platform commission is NO LONGER deducted here. It
 * used to be cut at earn-time using whatever plan the creator was on
 * back then. It's now calculated and deducted at WITHDRAWAL time instead
 * (see wallet.controller.js's requestWithdrawal), using the creator's
 * CURRENT plan at the moment they actually request a payout — so the
 * wallet balance a creator sees is the full gross amount they earned,
 * and the fee is transparently shown/deducted only when they cash out.
 * `platformCommission` is still returned (always 0) purely so callers
 * that log it on a Transaction record don't need special-casing.
 */
async function splitEarnings(grossAmount, creatorProfileId, relatedModel = null, relatedId = null) {
  const creator = await CreatorProfile.findById(creatorProfileId);

  let remaining = grossAmount;
  let agencyCommission = 0;

  if (creator?.agency) {
    const agency = await AgencyProfile.findById(creator.agency);
    if (agency) {
      agencyCommission = Math.round((remaining * agency.commissionPercent) / 100);
      remaining -= agencyCommission;

      agency.totalCommissionEarned += agencyCommission;
      agency.thisMonthCommission += agencyCommission;
      await agency.save();
    }
  }

  let referralCommission = 0;
  if (creator?.user) {
    referralCommission = await creditReferralCommission(creator.user, remaining, relatedModel, relatedId);
    remaining -= referralCommission;
  }

  return { platformCommission: 0, agencyCommission, referralCommission, netAmount: remaining };
}

/** Credits a creator's wallet + running earnings totals. `netAmount` here
 * is gross-of-platform-fee (agency/referral already subtracted by
 * splitEarnings above) — the platform fee is deducted later, at
 * withdrawal time, not here. */
async function creditCreator(creatorProfileId, netAmount) {
  const creator = await CreatorProfile.findById(creatorProfileId);
  if (!creator) return;

  creator.totalEarnings += netAmount;
  creator.thisMonthEarnings += netAmount;
  await creator.save();

  await User.findByIdAndUpdate(creator.user, { $inc: { walletBalance: netAmount } });
}

/** Debits a user's wallet balance (e.g. brand paying into escrow, or a
 * creator's extra-proposal fee). */
async function debitUser(userId, amount) {
  await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
}

/** Platform fee % to apply at withdrawal time — the creator's CURRENT
 * plan (not whatever plan they were on when they originally earned the
 * money). Falls back to the global SiteSettings rate for non-creators or
 * if the plan lookup fails, mirroring the old splitEarnings fallback. */
async function getPlatformFeePercentFor(user) {
  const { ROLES } = require('../constants/enums');
  if (user.role === ROLES.CREATOR) {
    try {
      // Lazy require to sidestep the same circular-dependency issue
      // noted in splitEarnings above.
      const { getCreatorPlanFields } = require('./subscription.service');
      const plan = await getCreatorPlanFields(user._id);
      if (plan?.platformFeePercent != null) return plan.platformFeePercent;
    } catch {
      // fall through to site default
    }
  }
  const settings = await SiteSettings.getSingleton().catch(() => null);
  return settings ? settings.platformCommissionPercent : env.platform.commissionPercent;
}

module.exports = { splitEarnings, creditCreator, debitUser, getPlatformFeePercentFor };