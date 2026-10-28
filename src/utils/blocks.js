// File: src/utils/blocks.js
const mongoose = require('mongoose');

// Helpers for "who should this user not see". Used by feed, stories,
// communities and chat. Blocking works both ways: if A blocks B, neither
// sees the other.

const Block = () => mongoose.model('Block');

/** Every user id hidden from `userId` (people they blocked + people who blocked them). */
async function hiddenUserIds(userId) {
  if (!userId) return [];
  const me = String(userId);
  const rows = await Block()
    .find({ $or: [{ blocker: userId }, { blocked: userId }] })
    .select('blocker blocked')
    .lean();
  const ids = new Map();
  rows.forEach((r) => {
    const other = String(r.blocker) === me ? r.blocked : r.blocker;
    ids.set(String(other), other);
  });
  return [...ids.values()];
}

/** True when either of the two users has blocked the other. */
async function isBlockedBetween(a, b) {
  if (!a || !b) return false;
  const row = await Block()
    .findOne({ $or: [{ blocker: a, blocked: b }, { blocker: b, blocked: a }] })
    .select('_id')
    .lean();
  return Boolean(row);
}

/** Adds "author not in hidden list" to a Mongo filter. */
function withoutAuthors(filter, hidden, field = 'author') {
  if (!hidden || !hidden.length) return filter;
  return { $and: [filter, { [field]: { $nin: hidden } }] };
}

module.exports = { hiddenUserIds, isBlockedBetween, withoutAuthors };