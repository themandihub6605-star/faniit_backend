/**
 * One-time migration: gives every user an 8-character referral code with
 * their role prefix (CR/BR/AG/FN/AD + 6 characters) and syncs agency
 * profiles to their owner's code.
 *
 * Run from the backend folder:  node scripts/migrateReferralCodes.js
 * Safe to run again — users who already have a correct code are skipped.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { User, AgencyProfile } = require('../src/models');
const { isValidReferralCode, referralPrefixFor } = require('../src/utils/generateReferralCode');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  let checked = 0;
  let updated = 0;
  let agenciesSynced = 0;

  for await (const user of User.find().cursor()) {
    checked += 1;
    const code = user.referralCode || '';
    const isCorrect = isValidReferralCode(code) && code.startsWith(referralPrefixFor(user.role));

    if (!isCorrect) {
      // Clearing it makes the User pre-save hook issue a fresh code.
      user.referralCode = undefined;
      await user.save({ validateBeforeSave: false });
      updated += 1;
    }

    if (user.role === 'agency') {
      const result = await AgencyProfile.updateOne(
        { user: user._id, referralCode: { $ne: user.referralCode } },
        { referralCode: user.referralCode }
      );
      if (result.modifiedCount) agenciesSynced += 1;
    }
  }

  console.log(`Checked ${checked} users — ${updated} got new codes, ${agenciesSynced} agency profiles synced.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});