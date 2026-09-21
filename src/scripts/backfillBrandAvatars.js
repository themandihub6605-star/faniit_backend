require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

/** One-time backfill: uploadLogo used to only save to BrandProfile.logoUrl
 * and never touched User.avatarUrl — so every brand who uploaded a logo
 * before that fix has a real logo that shows on their own brand profile,
 * but a blank/broken avatar everywhere the platform shows "the logged-in
 * user" (navbar, feed post composer, comments). This copies logoUrl onto
 * the linked User document for every brand that has one. Safe to run
 * multiple times — only touches users whose avatarUrl doesn't already
 * match their brand's logoUrl. */
async function backfill() {
  await connectDB();
  const db = mongoose.connection.db;
  const brands = db.collection('brandprofiles');
  const users = db.collection('users');

  const brandsWithLogo = await brands.find({ logoUrl: { $exists: true, $ne: '' } }).toArray();

  console.log(`[backfill] Found ${brandsWithLogo.length} brand(s) with a logo`);

  let updated = 0;
  for (const brand of brandsWithLogo) {
    const user = await users.findOne({ _id: brand.user });
    if (!user) {
      console.log(`[backfill] Skipping brand ${brand._id} — linked user not found`);
      continue;
    }
    if (user.avatarUrl === brand.logoUrl) continue; // already in sync

    await users.updateOne({ _id: brand.user }, { $set: { avatarUrl: brand.logoUrl } });
    updated += 1;
    console.log(`[backfill] Synced avatar for user ${brand.user} from brand ${brand._id}`);
  }

  console.log(`[backfill] Done — updated ${updated} user(s)`);
  await mongoose.disconnect();
  process.exit(0);
}

backfill().catch((err) => {
  console.error('[backfill] Failed:', err);
  process.exit(1);
});