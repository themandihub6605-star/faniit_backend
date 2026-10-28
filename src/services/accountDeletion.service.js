// File: src/services/accountDeletion.service.js
const mongoose = require('mongoose');
const { alertUser } = require('./alert.service');

// Deletes an account for good (personal data + posts) — used when an admin
// approves a "Delete account" request, and automatically when a request has
// waited DELETION_GRACE_DAYS (default 7) without an admin decision.
//
// Apple and Google require that a deletion requested in the app actually
// happens within a stated time, so requests never wait forever.

const GRACE_DAYS = Math.max(1, parseInt(process.env.DELETION_GRACE_DAYS, 10) || 7);
const SWEEP_MS = 60 * 60 * 1000; // hourly

const M = (name) => {
  try {
    return mongoose.model(name);
  } catch {
    return null;
  }
};

async function quietly(fn) {
  try {
    await fn();
  } catch (err) {
    console.error('[account-deletion] cleanup step failed:', err.message);
  }
}

/** Removes personal data and content. Returns true if the account was deleted now. */
async function deleteAccountNow(userId, { note = '' } = {}) {
  const User = M('User');
  const user = await User.findById(userId).select('name email isActive deletionStatus');
  if (!user || user.deletionStatus === 'approved') return false;

  const now = new Date();
  const email = user.email;
  const name = user.name;

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        deletedEmail: email,
        email: `deleted.${user._id}.${now.getTime()}@deleted.fanitt.invalid`,
        name: 'Deleted user',
        phone: '',
        avatarUrl: '',
        googleId: null,
        pushTokens: [],
        isActive: false,
        deletionStatus: 'approved',
        deletionReviewedAt: now,
        deletionNote: String(note || '').trim().slice(0, 500),
      },
      $unset: { passwordResetToken: 1, passwordResetExpires: 1 },
    },
  );

  // Their posts, stories and community posts/comments go too. Payments,
  // orders and invoices are kept (needed by law for accounting).
  const id = user._id;
  await quietly(() => M('Post')?.deleteMany({ author: id }));
  await quietly(() => M('Story')?.deleteMany({ author: id }));
  await quietly(() => M('CommunityComment')?.deleteMany({ author: id }));
  await quietly(() => M('CommunityPost')?.deleteMany({ author: id }));
  await quietly(() => M('CommunityMessage')?.updateMany({ sender: id }, { $set: { isRemoved: true } }));
  // No longer following anyone.
  for (const name of ['CreatorProfile', 'BrandProfile']) {
    // eslint-disable-next-line no-await-in-loop
    await quietly(() => M(name)?.updateMany({ followers: id }, { $pull: { followers: id }, $inc: { followerCount: -1 } }));
  }
  await quietly(() => M('Block')?.deleteMany({ $or: [{ blocker: id }, { blocked: id }] }));
  await quietly(() => M('TermsAcceptance')?.deleteMany({ user: id }));

  // Email only — the account is gone, so no in-app notification.
  alertUser({
    userId: id,
    inApp: false,
    title: 'Your Fanitt account has been deleted',
    message: 'As you requested, your Fanitt account and personal details have been deleted.',
    email: {
      to: email,
      name,
      body: 'As you requested, your Fanitt account and personal details have been deleted. You can create a new account with this email anytime.',
      ctaUrl: 'https://fanitt.com',
      ctaLabel: 'Visit Fanitt',
    },
  });
  return true;
}

/** Deletes requests that waited longer than the grace period. */
async function sweep() {
  const User = M('User');
  if (!User) return;
  const cutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000);
  const due = await User.find({ isActive: false, deletionStatus: 'pending', deletionRequestedAt: { $lte: cutoff } })
    .select('_id')
    .limit(50)
    .lean();
  for (const u of due) {
    // eslint-disable-next-line no-await-in-loop
    await quietly(() => deleteAccountNow(u._id, { note: `Deleted automatically after ${GRACE_DAYS} days` }));
  }
  if (due.length) console.log(`[account-deletion] auto-deleted ${due.length} account(s)`);
}

let timer = null;
function start() {
  if (timer || process.env.DISABLE_JOBS === 'true') return;
  setTimeout(() => sweep().catch(() => {}), 60 * 1000).unref?.();
  timer = setInterval(() => sweep().catch(() => {}), SWEEP_MS);
  timer.unref?.();
}

module.exports = { deleteAccountNow, sweep, start, GRACE_DAYS };