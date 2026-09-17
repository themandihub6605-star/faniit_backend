require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

/** One-time migration: converts any Post document still using the old
 * single mediaUrl/mediaType fields (from before the multi-media
 * mediaItems array was introduced) into the new mediaItems shape.
 * Safe to run multiple times — only touches docs missing mediaItems. */
async function migrate() {
  await connectDB();
  const db = mongoose.connection.db;
  const posts = db.collection('posts');

  const oldFormatPosts = await posts
    .find({ mediaItems: { $exists: false }, mediaUrl: { $exists: true } })
    .toArray();

  console.log(`[migrate] Found ${oldFormatPosts.length} old-format post(s) to convert`);

  for (const post of oldFormatPosts) {
    await posts.updateOne(
      { _id: post._id },
      {
        $set: { mediaItems: [{ url: post.mediaUrl, type: post.mediaType || 'image' }] },
        $unset: { mediaUrl: '', mediaType: '' },
      }
    );
    console.log(`[migrate] Converted post ${post._id}`);
  }

  console.log('[migrate] Done');
  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((err) => {
  console.error('[migrate] Failed:', err);
  process.exit(1);
});