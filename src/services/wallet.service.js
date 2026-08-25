const { User, CreatorProfile, AgencyProfile, SiteSettings } = require('../models');
const env = require('../config/env');
const { creditReferralCommission } = require('./referral.service');
const { getCreatorPlanFields } = require('./subscription.service');

/**
 * Splits a gross amount into platform commission, agency commission (if the
 * creator is under an agency), referral commission (if the creator was
 * referred by someone under the referral program) and the creator's net
 * take-home. All amounts in paise.
 *
 * Platform commission % now comes from the creator's active subscription
 * plan (9% Lite / 5% Pro) rather than a single global rate — falls back to
 * the global SiteSettings rate only if the plan lookup somehow fails.
 */
async function splitEarnings(grossAmount, creatorProfileId, relatedModel = null, relatedId = null) {
  const creator = await CreatorProfile.findById(creatorProfileId);

  let commissionPercent;
  try {
    const plan = creator?.user ? await getCreatorPlanFields(creator.user) : null;
    commissionPercent = plan ? plan.platformFeePercent : null;
  } catch {
    commissionPercent = null;
  }
  if (commissionPercent == null) {
    const settings = await SiteSettings.getSingleton().catch(() => null);
    commissionPercent = settings ? settings.platformCommissionPercent : env.platform.commissionPercent;
  }

  const platformCommission = Math.round((grossAmount * commissionPercent) / 100);
  let remaining = grossAmount - platformCommission;

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

  return { platformCommission, agencyCommission, referralCommission, netAmount: remaining };
}

/** Credits a creator's wallet + running earnings totals. */
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

module.exports = { splitEarnings, creditCreator, debitUser };