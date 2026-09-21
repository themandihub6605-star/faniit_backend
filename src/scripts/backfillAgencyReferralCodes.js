require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const generateReferralCode = require('../utils/generateReferralCode');

/** One-time backfill: agencies used to get a name-derived referral code
 * (e.g. "PRABHANSH4342") instead of the clean random 6-character code
 * every other referral code in the app uses. This regenerates a proper
 * 6-char code for any agency whose current code isn't already 6
 * characters from the correct alphabet — safe to run multiple times,
 * agencies already on a clean code are left untouched. */
const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

async function backfill() {
  await connectDB();
  const db = mongoose.connection.db;
  const agencies = db.collection('agencyprofiles');

  const all = await agencies.find({}).toArray();
  const toFix = all.filter((a) => !CODE_PATTERN.test(a.referralCode || ''));

  console.log(`[backfill] Found ${toFix.length} agency(ies) with an old-format referral code`);

  for (const agency of toFix) {
    let attempt = generateReferralCode();
    while (await agencies.findOne({ referralCode: attempt })) {
      attempt = generateReferralCode();
    }
    await agencies.updateOne({ _id: agency._id }, { $set: { referralCode: attempt } });
    console.log(`[backfill] Agency ${agency._id}: "${agency.referralCode}" -> "${attempt}"`);
  }

  console.log('[backfill] Done');
  await mongoose.disconnect();
  process.exit(0);
}

backfill().catch((err) => {
  console.error('[backfill] Failed:', err);
  process.exit(1);
});