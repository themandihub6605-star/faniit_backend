const { User, CreatorProfile, AgencyProfile } = require('../models');
const env = require('../config/env');

/**
 * Splits a gross amount into platform commission, agency commission (if the
 * creator is under an agency) and the creator's net take-home. All amounts
 * in paise. Percentages are read from env / the agency's own record so this
 * never has to be touched when rates change.
 */
async function splitEarnings(grossAmount, creatorProfileId) {
  const platformCommission = Math.round((grossAmount * env.platform.commissionPercent) / 100);
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

  return { platformCommission, agencyCommission, netAmount: remaining };
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
