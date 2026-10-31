const { User, CreatorProfile, AgencyProfile } = require('../models');
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

/** Platform fee % taken when this user withdraws. Only creators pay one —
 * their CURRENT plan's fee (Lite / Pro…), or the admin's fallback from
 * Billing settings. Brands, agencies and fans withdraw without a fee.
 * Full fee + GST calculation: billing.service.js withdrawalBreakdown. */
async function getPlatformFeePercentFor(user) {
  const { ROLES } = require('../constants/enums');
  if (user.role !== ROLES.CREATOR) return 0;
  // Lazy require — billing.service loads subscription.service, which loads this file.
  return require('./billing.service').creatorFeePercent(user);
}

module.exports = { splitEarnings, creditCreator, debitUser, getPlatformFeePercentFor };