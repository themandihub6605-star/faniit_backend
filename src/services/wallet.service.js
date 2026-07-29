const { User, CreatorProfile, AgencyProfile, SiteSettings } = require('../models');
const env = require('../config/env');
const { creditReferralCommission } = require('./referral.service');

/**
 * Splits a gross amount into platform commission, agency commission (if the
 * creator is under an agency), referral commission (if the creator was
 * referred by someone under the referral program) and the creator's net
 * take-home. All amounts in paise.
 *
 * `relatedModel`/`relatedId` are passed through so the referral commission
 * transaction can point back to the session/campaign that generated it.
 */
async function splitEarnings(grossAmount, creatorProfileId, relatedModel = null, relatedId = null) {
  // DB-backed so an Admin can change this from the Admin Panel without a
  // redeploy; falls back to the env var only if the settings doc is somehow
  // missing (shouldn't happen — getSingleton creates it on first read).
  const settings = await SiteSettings.getSingleton().catch(() => null);
  const commissionPercent = settings ? settings.platformCommissionPercent : env.platform.commissionPercent;

  const platformCommission = Math.round((grossAmount * commissionPercent) / 100);
  let remaining = grossAmount - platformCommission;

  let agencyCommission = 0;
  const creator = await CreatorProfile.findById(creatorProfileId);

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

  // Separate from the agency-link commission above — this is the generic
  // referral program (e.g. one Creator referred another Creator's signup).
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

/** Debits a user's wallet balance (e.g. brand paying into escrow). */
async function debitUser(userId, amount) {
  await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
}

module.exports = { splitEarnings, creditCreator, debitUser };