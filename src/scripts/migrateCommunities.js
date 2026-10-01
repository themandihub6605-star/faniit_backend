/**
 * One-time migration for the new community features. Existing memberships
 * become 'active', existing communities become public with chat on.
 * Safe to run more than once.  Run:  node scripts/migrateCommunities.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Community, CommunityMembership } = require('../src/models');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const members = await CommunityMembership.updateMany({ status: { $exists: false } }, { status: 'active' });
  const communities = await Community.updateMany(
    { visibility: { $exists: false } },
    { visibility: 'public', postPermission: 'all', chatEnabled: true, pendingRequestCount: 0 }
  );
  const activity = await Community.updateMany({ lastActivityAt: { $exists: false } }, [{ $set: { lastActivityAt: '$updatedAt' } }]);

  // Recount members so memberCount matches real active memberships.
  const counts = await CommunityMembership.aggregate([
    { $match: { status: 'active' } },
    { $group: { _id: '$community', count: { $sum: 1 } } },
  ]);
  for (const { _id, count } of counts) {
    // eslint-disable-next-line no-await-in-loop
    await Community.updateOne({ _id }, { memberCount: count });
  }

  console.log(
    `Memberships updated: ${members.modifiedCount}, communities updated: ${communities.modifiedCount}, ` +
      `activity dates set: ${activity.modifiedCount}, member counts refreshed: ${counts.length}`
  );
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});