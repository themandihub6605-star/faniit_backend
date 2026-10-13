const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

// Admin "manage" API — the screens the panel didn't have yet:
// reviews, stories, gifts & donations, sessions & bookings, campaign
// applications, wallets, community content, dispute history, legal pages,
// an advanced user search and a 360° view of one user.
// Admins only (see monitor.routes.js). New file — nothing existing changes.

require('../models');
try {
  require('../FanittStore/models');
} catch {
  /* store module not installed */
}

const M = (name) => {
  try {
    return mongoose.model(name);
  } catch {
    return null;
  }
};
const need = (name) => {
  const m = M(name);
  if (!m) throw ApiError.badRequest(`${name} isn't available on this server`);
  return m;
};
const safe = async (fn, fallback) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

const DAY_MS = 24 * 60 * 60 * 1000;
const OK = ['success', 'released'];
const PAID = ['success', 'released', 'in_escrow'];
const INBOUND_TX = ['session_payment', 'donation', 'gift', 'campaign_escrow_deposit', 'campaign_posting_fee', 'subscription_payment', 'extra_proposal_fee', 'store_sale'];
const USER_FIELDS = 'name email avatarUrl role';

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const searchRe = (q) => (q && String(q).trim() ? new RegExp(escapeRe(String(q).trim().slice(0, 80)), 'i') : null);

function paging(q, def = 25) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || def));
  return { page, limit, skip: (page - 1) * limit };
}
const pageOut = (items, total, p) => ({ items, total, page: p.page, pages: Math.max(1, Math.ceil(total / p.limit)), limit: p.limit });

async function sumField(model, match, field) {
  if (!model) return null;
  const r = await safe(() => model.aggregate([{ $match: match }, { $group: { _id: null, v: { $sum: `$${field}` } } }]), null);
  return r ? r[0]?.v || 0 : null;
}
async function countOf(model, match) {
  if (!model) return null;
  return safe(() => model.countDocuments(match), null);
}

/** Ids of users whose name or email matches. */
async function userIdsMatching(q, limit = 500) {
  const re = searchRe(q);
  if (!re) return null;
  const users = await M('User').find({ $or: [{ name: re }, { email: re }] }).select('_id').limit(limit).lean();
  return users.map((u) => u._id);
}
/** CreatorProfile ids for matching users. */
async function creatorIdsForUsers(userIds) {
  const CP = M('CreatorProfile');
  if (!CP || !userIds) return null;
  return (await CP.find({ user: { $in: userIds } }).select('_id').lean()).map((c) => c._id);
}

// ===========================================================================
// Reviews
// ===========================================================================
// GET /reviews?visibility=visible|hidden|flagged|all&rating=1..5&search=&page=
const listReviews = catchAsync(async (req, res) => {
  const Review = need('Review');
  const p = paging(req.query);
  const match = {};
  const vis = req.query.visibility || 'visible';
  if (vis === 'visible') match.isHidden = { $ne: true };
  else if (vis === 'hidden') match.isHidden = true;
  else if (vis === 'flagged') match.isFlagged = true;
  const rating = Number(req.query.rating);
  if (rating >= 1 && rating <= 5) match.rating = rating;
  if (req.query.related === 'Session' || req.query.related === 'Campaign') match.relatedModel = req.query.related;
  if (isId(req.query.toUser)) match.toUser = req.query.toUser;
  const re = searchRe(req.query.search);
  if (re) {
    const ids = await userIdsMatching(req.query.search);
    match.$or = [{ comment: re }, { fromUser: { $in: ids } }, { toUser: { $in: ids } }];
  }

  const [items, total, visible, hidden, flagged, byRating] = await Promise.all([
    Review.find(match).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).populate('fromUser', USER_FIELDS).populate('toUser', USER_FIELDS).lean(),
    Review.countDocuments(match),
    Review.countDocuments({ isHidden: { $ne: true } }),
    Review.countDocuments({ isHidden: true }),
    Review.countDocuments({ isFlagged: true }),
    Promise.all([1, 2, 3, 4, 5].map((r) => Review.countDocuments({ rating: r, isHidden: { $ne: true } }))),
  ]);
  const n = byRating.reduce((a, b) => a + b, 0);
  const avg = n ? byRating.reduce((s, c, i) => s + c * (i + 1), 0) / n : null;

  return new ApiResponse(200, { ...pageOut(items, total, p), summary: { visible, hidden, flagged, average: avg, byRating: byRating.map((count, i) => ({ rating: i + 1, count })) } }, 'Reviews fetched').send(res);
});

// PATCH /reviews/:id  { hidden: boolean }
const setReviewVisibility = catchAsync(async (req, res) => {
  const Review = need('Review');
  if (!isId(req.params.id)) throw ApiError.badRequest('Invalid review id');
  const hidden = req.body?.hidden !== false;
  const review = await Review.findByIdAndUpdate(req.params.id, { isHidden: hidden, ...(hidden ? {} : { isFlagged: false }) }, { new: true });
  if (!review) throw ApiError.notFound('Review not found');
  return new ApiResponse(200, review, hidden ? 'Review hidden' : 'Review visible again').send(res);
});

// ===========================================================================
// Stories
// ===========================================================================
// GET /stories?status=live|expired|all&search=&page=
const listStories = catchAsync(async (req, res) => {
  const Story = need('Story');
  const p = paging(req.query, 24);
  const now = new Date();
  const match = {};
  if ((req.query.status || 'live') === 'live') match.expiresAt = { $gt: now };
  else if (req.query.status === 'expired') match.expiresAt = { $lte: now };
  const re = searchRe(req.query.search);
  if (re) {
    const ids = await userIdsMatching(req.query.search);
    match.$or = [{ caption: re }, { author: { $in: ids } }];
  }
  const [items, total, live, today, views] = await Promise.all([
    Story.find(match).select('-viewers').sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).populate('author', USER_FIELDS).lean(),
    Story.countDocuments(match),
    Story.countDocuments({ expiresAt: { $gt: now } }),
    Story.countDocuments({ createdAt: { $gte: new Date(now - DAY_MS) } }),
    sumField(Story, { expiresAt: { $gt: now } }, 'viewCount'),
  ]);
  return new ApiResponse(200, { ...pageOut(items, total, p), summary: { live, last24h: today, liveViews: views } }, 'Stories fetched').send(res);
});

// DELETE /stories/:id
const deleteStory = catchAsync(async (req, res) => {
  const Story = need('Story');
  if (!isId(req.params.id)) throw ApiError.badRequest('Invalid story id');
  const story = await Story.findByIdAndDelete(req.params.id);
  if (!story) throw ApiError.notFound('Story not found');
  return new ApiResponse(200, { _id: story._id }, 'Story removed').send(res);
});

// ===========================================================================
// Gifts & donations
// ===========================================================================
// GET /gifts?kind=all|gift|donation|fanbox&days=&search=&page=
const listGifts = catchAsync(async (req, res) => {
  const Gift = M('Gift');
  const Donation = M('Donation');
  const StoreOrder = M('StoreOrder');
  const CP = M('CreatorProfile');
  const p = paging(req.query);
  const kind = req.query.kind || 'all';
  const days = Number(req.query.days);
  const since = days > 0 ? { createdAt: { $gte: new Date(Date.now() - days * DAY_MS) } } : {};

  let fromIds = null;
  let toCreatorIds = null;
  let toUserIds = null;
  if (searchRe(req.query.search)) {
    const ids = await userIdsMatching(req.query.search);
    fromIds = ids;
    toUserIds = ids;
    toCreatorIds = await creatorIdsForUsers(ids);
  }
  const giftMatch = { ...since, ...(fromIds ? { $or: [{ fromUser: { $in: fromIds } }, { toCreator: { $in: toCreatorIds } }] } : {}) };
  const fanboxMatch = { itemType: 'fanbox', status: 'paid', ...since, ...(fromIds ? { $or: [{ buyer: { $in: fromIds } }, { seller: { $in: toUserIds } }] } : {}) };

  const want = (k) => kind === 'all' || kind === k;
  const take = p.skip + p.limit;
  const [gifts, donations, fanbox, gCount, dCount, fCount, gSum, dSum, fSum] = await Promise.all([
    want('gift') && Gift ? Gift.find(giftMatch).sort({ createdAt: -1 }).limit(take).populate('fromUser', USER_FIELDS).populate({ path: 'toCreator', select: 'user slug', populate: { path: 'user', select: USER_FIELDS } }).lean() : [],
    want('donation') && Donation ? Donation.find(giftMatch).sort({ createdAt: -1 }).limit(take).populate('fromUser', USER_FIELDS).populate({ path: 'toCreator', select: 'user slug', populate: { path: 'user', select: USER_FIELDS } }).populate('session', 'title').lean() : [],
    want('fanbox') && StoreOrder ? StoreOrder.find(fanboxMatch).sort({ createdAt: -1 }).limit(take).populate('buyer', USER_FIELDS).populate('seller', USER_FIELDS).lean() : [],
    want('gift') ? countOf(Gift, giftMatch) : 0,
    want('donation') ? countOf(Donation, giftMatch) : 0,
    want('fanbox') ? countOf(StoreOrder, fanboxMatch) : 0,
    want('gift') ? sumField(Gift, giftMatch, 'amount') : 0,
    want('donation') ? sumField(Donation, giftMatch, 'amount') : 0,
    want('fanbox') ? sumField(StoreOrder, fanboxMatch, 'amount') : 0,
  ]);

  const rows = [
    ...gifts.map((g) => ({ _id: g._id, kind: 'gift', amount: g.amount, message: g.message, from: g.fromUser, to: g.toCreator?.user || null, createdAt: g.createdAt })),
    ...donations.map((d) => ({ _id: d._id, kind: 'donation', amount: d.amount, message: d.message, from: d.fromUser, to: d.toCreator?.user || null, context: d.session?.title || '', createdAt: d.createdAt })),
    ...fanbox.map((o) => ({ _id: o._id, kind: 'fanbox', amount: o.amount, message: o.message, from: o.buyer, to: o.seller, context: o.context || '', createdAt: o.createdAt })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Top senders and receivers across all three (by amount).
  const tally = (list, key) => {
    const m = new Map();
    list.forEach((r) => {
      const who = r[key];
      if (!who?._id) return;
      const k = String(who._id);
      const cur = m.get(k) || { user: who, amount: 0, count: 0 };
      cur.amount += r.amount || 0;
      cur.count += 1;
      m.set(k, cur);
    });
    return [...m.values()].sort((a, b) => b.amount - a.amount).slice(0, 5);
  };
  // For the leaders use a wider window (up to 1,000 recent rows of each).
  const wide = await Promise.all([
    want('gift') && Gift ? Gift.find(giftMatch).sort({ createdAt: -1 }).limit(1000).select('amount fromUser toCreator').populate('fromUser', USER_FIELDS).populate({ path: 'toCreator', select: 'user', populate: { path: 'user', select: USER_FIELDS } }).lean() : [],
    want('donation') && Donation ? Donation.find(giftMatch).sort({ createdAt: -1 }).limit(1000).select('amount fromUser toCreator').populate('fromUser', USER_FIELDS).populate({ path: 'toCreator', select: 'user', populate: { path: 'user', select: USER_FIELDS } }).lean() : [],
    want('fanbox') && StoreOrder ? StoreOrder.find(fanboxMatch).sort({ createdAt: -1 }).limit(1000).select('amount buyer seller').populate('buyer', USER_FIELDS).populate('seller', USER_FIELDS).lean() : [],
  ]);
  const flat = [
    ...wide[0].map((g) => ({ amount: g.amount, from: g.fromUser, to: g.toCreator?.user })),
    ...wide[1].map((g) => ({ amount: g.amount, from: g.fromUser, to: g.toCreator?.user })),
    ...wide[2].map((o) => ({ amount: o.amount, from: o.buyer, to: o.seller })),
  ];

  const total = (gCount || 0) + (dCount || 0) + (fCount || 0);
  return new ApiResponse(
    200,
    {
      ...pageOut(rows.slice(p.skip, p.skip + p.limit), total, p),
      summary: {
        gifts: { count: gCount, amount: gSum },
        donations: { count: dCount, amount: dSum },
        fanbox: { count: fCount, amount: fSum },
        topSenders: tally(flat, 'from'),
        topReceivers: tally(flat, 'to'),
      },
      hasCreatorProfiles: !!CP,
    },
    'Gifts fetched'
  ).send(res);
});

// ===========================================================================
// Sessions & bookings
// ===========================================================================
function sessionStatusMatch(status) {
  const now = new Date();
  switch (status) {
    case 'upcoming':
      return { scheduledAt: { $gte: now }, isCancelled: { $ne: true }, isCompleted: { $ne: true } };
    case 'live':
      return { isLive: true, isCancelled: { $ne: true } };
    case 'completed':
      return { $or: [{ isCompleted: true }, { scheduledAt: { $lt: now }, isCancelled: { $ne: true } }] };
    case 'cancelled':
      return { isCancelled: true };
    default:
      return {};
  }
}

// GET /sessions?status=upcoming|live|completed|cancelled|all&search=&page=
const listSessions = catchAsync(async (req, res) => {
  const Session = need('Session');
  const Booking = M('Booking');
  const p = paging(req.query);
  const match = sessionStatusMatch(req.query.status || 'upcoming');
  const re = searchRe(req.query.search);
  if (re) {
    const creators = await creatorIdsForUsers(await userIdsMatching(req.query.search));
    const or = [{ title: re }, { creator: { $in: creators || [] } }];
    if (match.$or) {
      match.$and = [{ $or: match.$or }, { $or: or }];
      delete match.$or;
    } else match.$or = or;
  }
  const sort = req.query.status === 'upcoming' || !req.query.status ? { scheduledAt: 1 } : { scheduledAt: -1 };
  const [items, total, upcoming, live, cancelled] = await Promise.all([
    Session.find(match).sort(sort).skip(p.skip).limit(p.limit).populate({ path: 'creator', select: 'user slug', populate: { path: 'user', select: USER_FIELDS } }).lean(),
    Session.countDocuments(match),
    Session.countDocuments(sessionStatusMatch('upcoming')),
    Session.countDocuments(sessionStatusMatch('live')),
    Session.countDocuments({ isCancelled: true }),
  ]);
  // Bookings + money per session on this page.
  const ids = items.map((s) => s._id);
  const bookings = Booking && ids.length ? await Booking.find({ session: { $in: ids } }).select('session status amountPaid').lean() : [];
  const per = new Map();
  bookings.forEach((b) => {
    const k = String(b.session);
    const cur = per.get(k) || { booked: 0, cancelled: 0, revenue: 0 };
    if (b.status === 'cancelled') cur.cancelled += 1;
    else {
      cur.booked += 1;
      cur.revenue += b.amountPaid || 0;
    }
    per.set(k, cur);
  });
  const rows = items.map((s) => ({ ...s, stats: per.get(String(s._id)) || { booked: 0, cancelled: 0, revenue: 0 } }));
  return new ApiResponse(200, { ...pageOut(rows, total, p), summary: { upcoming, live, cancelled } }, 'Sessions fetched').send(res);
});

// GET /sessions/:id/bookings
const sessionBookings = catchAsync(async (req, res) => {
  const Booking = need('Booking');
  if (!isId(req.params.id)) throw ApiError.badRequest('Invalid session id');
  const items = await Booking.find({ session: req.params.id })
    .sort({ createdAt: -1 })
    .limit(500)
    .populate('user', `${USER_FIELDS} phone`)
    .populate('transaction', 'amount status razorpayPaymentId razorpayOrderId')
    .lean();
  return new ApiResponse(200, items, 'Bookings fetched').send(res);
});

// POST /sessions/:id/cancel  { reason }
// Cancels the session, cancels its bookings and tells everyone (in-app +
// push + email). Razorpay refunds are NOT automatic on this backend, so the
// paid bookings come back in the response for the admin to refund.
const cancelSession = catchAsync(async (req, res) => {
  const Session = need('Session');
  const Booking = M('Booking');
  if (!isId(req.params.id)) throw ApiError.badRequest('Invalid session id');
  const reason = String(req.body?.reason || '').trim().slice(0, 300);
  const session = await Session.findById(req.params.id).populate({ path: 'creator', select: 'user', populate: { path: 'user', select: 'name email' } });
  if (!session) throw ApiError.notFound('Session not found');
  if (session.isCancelled) throw ApiError.badRequest('This session is already cancelled');

  // updateOne (not save) so an old document that fails today's validation
  // can still be cancelled.
  await Session.updateOne({ _id: session._id }, { $set: { isCancelled: true, isLive: false } });

  const bookings = Booking ? await Booking.find({ session: session._id, status: { $ne: 'cancelled' } }).populate('user', 'name email').populate('transaction', 'amount status razorpayPaymentId').lean() : [];
  if (Booking && bookings.length) await Booking.updateMany({ _id: { $in: bookings.map((b) => b._id) } }, { $set: { status: 'cancelled' } });

  let notify = null;
  let sendEmail = null;
  try {
    ({ notify } = require('../services/notification.service'));
  } catch {
    /* no notifications */
  }
  try {
    ({ sendSessionCancelledEmail: sendEmail } = require('../services/email.service'));
  } catch {
    /* no email */
  }
  const why = reason ? ` Reason: ${reason}` : '';
  const creatorUser = session.creator?.user;
  const tasks = [];
  bookings.forEach((b) => {
    if (!b.user?._id) return;
    if (notify) tasks.push(notify({ userId: b.user._id, type: 'general', title: 'Session cancelled', message: `“${session.title}” was cancelled by Fanitt.${why}`, relatedModel: 'Session', relatedId: session._id }));
    if (sendEmail && b.user.email) tasks.push(Promise.resolve(sendEmail({ to: b.user.email, name: b.user.name, sessionTitle: session.title, scheduledAt: session.scheduledAt, otherPartyName: creatorUser?.name || 'the creator' })));
  });
  if (notify && creatorUser?._id) tasks.push(notify({ userId: creatorUser._id, type: 'general', title: 'Your session was cancelled', message: `Fanitt cancelled “${session.title}”.${why}`, relatedModel: 'Session', relatedId: session._id }));
  await Promise.allSettled(tasks.map((t) => Promise.resolve(t).catch(() => null)));

  const toRefund = bookings
    .filter((b) => (b.amountPaid || 0) > 0)
    .map((b) => ({ bookingId: b._id, user: b.user ? { _id: b.user._id, name: b.user.name, email: b.user.email } : null, amount: b.amountPaid, razorpayPaymentId: b.transaction?.razorpayPaymentId || '' }));

  return new ApiResponse(200, { session: { _id: session._id, title: session.title }, cancelledBookings: bookings.length, notified: bookings.length + (creatorUser ? 1 : 0), toRefund }, 'Session cancelled').send(res);
});

// GET /bookings?status=&search=&page=
const listBookings = catchAsync(async (req, res) => {
  const Booking = need('Booking');
  const p = paging(req.query);
  const match = {};
  if (['pending', 'confirmed', 'cancelled', 'completed'].includes(req.query.status)) match.status = req.query.status;
  if (searchRe(req.query.search)) match.user = { $in: await userIdsMatching(req.query.search) };
  const [items, total, confirmed, cancelled, paidSum] = await Promise.all([
    Booking.find(match)
      .sort({ createdAt: -1 })
      .skip(p.skip)
      .limit(p.limit)
      .populate('user', USER_FIELDS)
      .populate({ path: 'session', select: 'title scheduledAt isCancelled creator price type', populate: { path: 'creator', select: 'user', populate: { path: 'user', select: USER_FIELDS } } })
      .lean(),
    Booking.countDocuments(match),
    Booking.countDocuments({ status: 'confirmed' }),
    Booking.countDocuments({ status: 'cancelled' }),
    sumField(Booking, { status: { $in: ['confirmed', 'completed'] } }, 'amountPaid'),
  ]);
  return new ApiResponse(200, { ...pageOut(items, total, p), summary: { confirmed, cancelled, paid: paidSum } }, 'Bookings fetched').send(res);
});

// ===========================================================================
// Campaign applications
// ===========================================================================
// GET /applications?status=&search=&campaign=&page=
const listApplications = catchAsync(async (req, res) => {
  const Application = need('Application');
  const Campaign = M('Campaign');
  const p = paging(req.query);
  const match = {};
  if (['pending', 'accepted', 'rejected'].includes(req.query.status)) match.status = req.query.status;
  if (isId(req.query.campaign)) match.campaign = req.query.campaign;
  const re = searchRe(req.query.search);
  if (re) {
    const creators = await creatorIdsForUsers(await userIdsMatching(req.query.search));
    const camps = Campaign ? (await Campaign.find({ title: re }).select('_id').limit(500).lean()).map((c) => c._id) : [];
    match.$or = [{ creator: { $in: creators || [] } }, { campaign: { $in: camps } }, { pitch: re }];
  }
  const [items, total, pending, accepted, rejected] = await Promise.all([
    Application.find(match)
      .sort({ createdAt: -1 })
      .skip(p.skip)
      .limit(p.limit)
      .populate({ path: 'creator', select: 'user slug followerCount', populate: { path: 'user', select: USER_FIELDS } })
      .populate({ path: 'campaign', select: 'title budget status brand', populate: { path: 'brand', select: 'companyName user' } })
      .lean(),
    Application.countDocuments(match),
    Application.countDocuments({ status: 'pending' }),
    Application.countDocuments({ status: 'accepted' }),
    Application.countDocuments({ status: 'rejected' }),
  ]);
  return new ApiResponse(200, { ...pageOut(items, total, p), summary: { pending, accepted, rejected } }, 'Applications fetched').send(res);
});

// ===========================================================================
// Wallets
// ===========================================================================
// GET /wallets?search=&role=&page=   (users with money in their wallet)
const listWallets = catchAsync(async (req, res) => {
  const User = need('User');
  const Withdrawal = M('Withdrawal');
  const p = paging(req.query);
  const match = req.query.all === 'true' ? {} : { walletBalance: { $gt: 0 } };
  if (['creator', 'brand', 'fan', 'agency'].includes(req.query.role)) match.role = req.query.role;
  const re = searchRe(req.query.search);
  if (re) match.$or = [{ name: re }, { email: re }];
  const [items, total, totalBalance, holders] = await Promise.all([
    User.find(match).select(`${USER_FIELDS} walletBalance walletFeeExempt createdAt`).sort({ walletBalance: -1 }).skip(p.skip).limit(p.limit).lean(),
    User.countDocuments(match),
    sumField(User, { walletBalance: { $gt: 0 } }, 'walletBalance'),
    User.countDocuments({ walletBalance: { $gt: 0 } }),
  ]);
  const ids = items.map((u) => u._id);
  const wds = Withdrawal && ids.length ? await Withdrawal.find({ user: { $in: ids } }).select('user amount netPayoutAmount status').lean().catch(() => []) : [];
  const per = new Map();
  wds.forEach((w) => {
    const k = String(w.user);
    const cur = per.get(k) || { pending: 0, paid: 0 };
    if (['initiated', 'processing'].includes(w.status)) cur.pending += w.amount || 0;
    if (w.status === 'completed') cur.paid += w.netPayoutAmount || w.amount || 0;
    per.set(k, cur);
  });
  const pendingAll = await sumField(Withdrawal, { status: { $in: ['initiated', 'processing'] } }, 'amount');
  const rows = items.map((u) => ({ ...u, withdrawals: per.get(String(u._id)) || { pending: 0, paid: 0 } }));
  return new ApiResponse(200, { ...pageOut(rows, total, p), summary: { totalBalance, holders, pendingWithdrawals: pendingAll } }, 'Wallets fetched').send(res);
});

// ===========================================================================
// Community content (posts, comments, chat)
// ===========================================================================
const CONTENT_KINDS = {
  comments: { model: 'CommunityComment', author: 'author', text: 'text' },
  messages: { model: 'CommunityMessage', author: 'sender', text: 'text' },
};

// GET /community-content?kind=comments|messages&community=&search=&page=
const listCommunityContent = catchAsync(async (req, res) => {
  const kind = CONTENT_KINDS[req.query.kind] ? req.query.kind : 'comments';
  const cfg = CONTENT_KINDS[kind];
  const Model = need(cfg.model);
  const p = paging(req.query, 30);
  const match = kind === 'messages' ? { isRemoved: { $ne: true } } : {};
  if (isId(req.query.community)) match.community = req.query.community;
  const re = searchRe(req.query.search);
  if (re) match.$or = [{ [cfg.text]: re }, { [cfg.author]: { $in: await userIdsMatching(req.query.search) } }];
  const [items, total] = await Promise.all([
    Model.find(match).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).populate(cfg.author, USER_FIELDS).populate('community', 'name slug').lean(),
    Model.countDocuments(match),
  ]);
  const rows = items.map((r) => ({ _id: r._id, kind, text: r[cfg.text], author: r[cfg.author], community: r.community, post: r.post || null, likeCount: r.likeCount || 0, createdAt: r.createdAt }));
  return new ApiResponse(200, pageOut(rows, total, p), 'Community content fetched').send(res);
});

// DELETE /community-content/:kind/:id
const removeCommunityContent = catchAsync(async (req, res) => {
  const cfg = CONTENT_KINDS[req.params.kind];
  if (!cfg) throw ApiError.badRequest('Unknown content type');
  if (!isId(req.params.id)) throw ApiError.badRequest('Invalid id');
  const Model = need(cfg.model);
  if (req.params.kind === 'messages') {
    const msg = await Model.findByIdAndUpdate(req.params.id, { isRemoved: true }, { new: true });
    if (!msg) throw ApiError.notFound('Message not found');
    return new ApiResponse(200, { _id: msg._id }, 'Message removed').send(res);
  }
  const comment = await Model.findById(req.params.id);
  if (!comment) throw ApiError.notFound('Comment not found');
  // Remove the comment and its replies, then fix the counters.
  const replies = await Model.find({ parentComment: comment._id }).select('_id').lean();
  const removed = 1 + replies.length;
  await Model.deleteMany({ _id: { $in: [comment._id, ...replies.map((r) => r._id)] } });
  const CommunityPost = M('CommunityPost');
  if (CommunityPost && comment.post) await safe(() => CommunityPost.updateOne({ _id: comment.post, commentCount: { $gte: removed } }, { $inc: { commentCount: -removed } }), null);
  if (comment.parentComment) await safe(() => Model.updateOne({ _id: comment.parentComment, replyCount: { $gte: 1 } }, { $inc: { replyCount: -1 } }), null);
  return new ApiResponse(200, { _id: comment._id, removed }, 'Comment removed').send(res);
});

// GET /communities/:id/members?status=&search=&page=
const communityMembers = catchAsync(async (req, res) => {
  const Membership = need('CommunityMembership');
  const Community = need('Community');
  const StoreOrder = M('StoreOrder');
  if (!isId(req.params.id)) throw ApiError.badRequest('Invalid community id');
  const p = paging(req.query, 30);
  const community = await Community.findById(req.params.id).select('name slug isPaid memberCount createdBy plans').populate('createdBy', USER_FIELDS).lean();
  if (!community) throw ApiError.notFound('Community not found');
  const match = { community: community._id };
  if (req.query.status) match.status = req.query.status;
  if (req.query.access === 'paid' || req.query.access === 'free') match.access = req.query.access;
  if (searchRe(req.query.search)) match.user = { $in: await userIdsMatching(req.query.search) };
  const [items, total, active, paid, earnings, posts] = await Promise.all([
    Membership.find(match).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).populate('user', USER_FIELDS).lean(),
    Membership.countDocuments(match),
    Membership.countDocuments({ community: community._id, status: 'active' }),
    Membership.countDocuments({ community: community._id, access: 'paid', status: 'active' }),
    sumField(StoreOrder, { itemType: 'community', itemId: community._id, status: 'paid' }, 'amount'),
    countOf(M('CommunityPost'), { community: community._id }),
  ]);
  return new ApiResponse(200, { ...pageOut(items, total, p), community, summary: { active, paid, earnings, posts } }, 'Members fetched').send(res);
});

// ===========================================================================
// Dispute history (resolved milestone disputes)
// ===========================================================================
const disputeHistory = catchAsync(async (req, res) => {
  const Dispute = need('Dispute');
  const p = paging(req.query);
  const match = { status: { $ne: 'open' } };
  const [items, total] = await Promise.all([
    Dispute.find(match)
      .sort({ 'resolution.resolvedAt': -1, updatedAt: -1 })
      .skip(p.skip)
      .limit(p.limit)
      .populate({ path: 'campaign', select: 'title budget brand', populate: { path: 'brand', select: 'companyName' } })
      .populate('milestone', 'title amount')
      .populate('raisedBy', USER_FIELDS)
      .populate('resolution.resolvedBy', 'name email')
      .lean(),
    Dispute.countDocuments(match),
  ]);
  return new ApiResponse(200, pageOut(items, total, p), 'Dispute history fetched').send(res);
});

// ===========================================================================
// Legal pages (the .txt files the app and website read)
// ===========================================================================
const LEGAL_DIR = path.join(__dirname, '..', 'content', 'legal');
const LEGAL = { 'privacy-policy': 'Privacy Policy', 'terms-of-use': 'Terms of Use' };

const listLegal = catchAsync(async (req, res) => {
  const docs = Object.entries(LEGAL).map(([slug, title]) => {
    const file = path.join(LEGAL_DIR, `${slug}.txt`);
    try {
      const stat = fs.statSync(file);
      return { slug, title, text: fs.readFileSync(file, 'utf8'), updatedAt: stat.mtime, size: stat.size };
    } catch {
      return { slug, title, text: '', updatedAt: null, size: 0, missing: true };
    }
  });
  return new ApiResponse(200, docs, 'Legal pages fetched').send(res);
});

// PUT /legal/:slug  { text }
const saveLegal = catchAsync(async (req, res) => {
  const slug = req.params.slug;
  if (!LEGAL[slug]) throw ApiError.notFound('Unknown page');
  const text = String(req.body?.text ?? '');
  if (text.trim().length < 50) throw ApiError.badRequest('The text is too short — paste the full page');
  if (text.length > 400_000) throw ApiError.badRequest('The text is too long');
  const file = path.join(LEGAL_DIR, `${slug}.txt`);
  fs.mkdirSync(LEGAL_DIR, { recursive: true });
  // Keep the previous version next to it.
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(LEGAL_DIR, `${slug}.previous.txt`));
  } catch {
    /* backup is best effort */
  }
  fs.writeFileSync(file, text.replace(/\r\n/g, '\n'), 'utf8');
  return new ApiResponse(200, { slug, updatedAt: new Date() }, `${LEGAL[slug]} saved`).send(res);
});

// ===========================================================================
// Users — advanced search
// ===========================================================================
// GET /users?search=&role=&status=active|suspended&provider=local|google
//   &joined=7|30|90&active=7|30&verified=verified|pending|rejected&sort=new|old|name|login|wallet&page=
const searchUsers = catchAsync(async (req, res) => {
  const User = need('User');
  const p = paging(req.query, 30);
  const q = req.query;
  const match = {};
  if (['creator', 'brand', 'fan', 'agency', 'admin'].includes(q.role)) match.role = q.role;
  if (q.status === 'suspended') match.isSuspended = true;
  if (q.status === 'active') match.isSuspended = { $ne: true };
  if (q.provider === 'google' || q.provider === 'local') match.authProvider = q.provider;
  if (Number(q.joined) > 0) match.createdAt = { $gte: new Date(Date.now() - Number(q.joined) * DAY_MS) };
  if (Number(q.active) > 0) match.lastLoginAt = { $gte: new Date(Date.now() - Number(q.active) * DAY_MS) };
  if (q.inactive && Number(q.inactive) > 0) match.$or = [{ lastLoginAt: { $lt: new Date(Date.now() - Number(q.inactive) * DAY_MS) } }, { lastLoginAt: null }];
  const re = searchRe(q.search);
  if (re) {
    const or = [{ name: re }, { email: re }, { phone: re }];
    if (isId(q.search)) or.push({ _id: q.search });
    if (match.$or) {
      match.$and = [{ $or: match.$or }, { $or: or }];
      delete match.$or;
    } else match.$or = or;
  }
  if (['verified', 'pending', 'rejected'].includes(q.verified)) {
    const CP = M('CreatorProfile');
    const BP = M('BrandProfile');
    const [c, b] = await Promise.all([
      CP ? CP.find({ verificationStatus: q.verified }).select('user').limit(20000).lean() : [],
      BP ? BP.find({ verificationStatus: q.verified }).select('user').limit(20000).lean() : [],
    ]);
    match._id = { $in: [...c, ...b].map((x) => x.user) };
  }
  const SORTS = { new: { createdAt: -1 }, old: { createdAt: 1 }, name: { name: 1 }, login: { lastLoginAt: -1 }, wallet: { walletBalance: -1 } };
  const [items, total] = await Promise.all([
    User.find(match).select('name email phone avatarUrl role isSuspended authProvider lastLoginAt createdAt walletBalance isEmailVerified').sort(SORTS[q.sort] || SORTS.new).skip(p.skip).limit(p.limit).lean(),
    User.countDocuments(match),
  ]);
  // Attach verification status for creators and brands on this page.
  const CP = M('CreatorProfile');
  const BP = M('BrandProfile');
  const ids = items.map((u) => u._id);
  const [cps, bps] = await Promise.all([
    CP && ids.length ? CP.find({ user: { $in: ids } }).select('user verificationStatus followerCount slug').lean() : [],
    BP && ids.length ? BP.find({ user: { $in: ids } }).select('user verificationStatus companyName').lean() : [],
  ]);
  const prof = new Map([...cps, ...bps].map((x) => [String(x.user), x]));
  const rows = items.map((u) => {
    const x = prof.get(String(u._id));
    return { ...u, verificationStatus: x?.verificationStatus || null, followerCount: x?.followerCount ?? null, slug: x?.slug || null, companyName: x?.companyName || null };
  });
  return new ApiResponse(200, pageOut(rows, total, p), 'Users fetched').send(res);
});

// ===========================================================================
// User 360 — everything about one user in numbers
// ===========================================================================
const userOverview = catchAsync(async (req, res) => {
  const User = need('User');
  if (!isId(req.params.id)) throw ApiError.badRequest('Invalid user id');
  const user = await User.findById(req.params.id).select('name email role walletBalance lastLoginAt createdAt').lean();
  if (!user) throw ApiError.notFound('User not found');
  const uid = user._id;

  const CP = M('CreatorProfile');
  const BP = M('BrandProfile');
  const creator = CP ? await CP.findOne({ user: uid }).select('_id followerCount averageRating profileViews verificationStatus slug').lean() : null;
  const brand = BP ? await BP.findOne({ user: uid }).select('_id verificationStatus companyName').lean() : null;

  const Tx = M('Transaction');
  const Post = M('Post');
  const Story = M('Story');
  const Session = M('Session');
  const Booking = M('Booking');
  const Review = M('Review');
  const Membership = M('CommunityMembership');
  const Community = M('Community');
  const Campaign = M('Campaign');
  const Application = M('Application');
  const Withdrawal = M('Withdrawal');
  const StoreOrder = M('StoreOrder');
  const ShopOrder = M('ShopOrder');
  const AuthEvent = M('AuthEvent');
  const since30 = new Date(Date.now() - 30 * DAY_MS);

  const [
    earned,
    earnedCount,
    spent,
    spentCount,
    posts,
    reels,
    stories,
    sessionsHosted,
    bookingsMade,
    reviewsReceived,
    reviewsGiven,
    receivedAvgRows,
    communitiesOwned,
    communitiesJoined,
    campaigns,
    applications,
    applicationsAccepted,
    withdrawnPaid,
    withdrawPending,
    storeBought,
    storeSold,
    storeSoldAmount,
    shopBought,
    failedLogins,
    logins,
    recentTx,
  ] = await Promise.all([
    sumField(Tx, { to: uid, status: { $in: OK } }, 'netAmount'),
    countOf(Tx, { to: uid, status: { $in: OK } }),
    sumField(Tx, { from: uid, status: { $in: PAID }, type: { $in: INBOUND_TX } }, 'amount'),
    countOf(Tx, { from: uid, status: { $in: PAID }, type: { $in: INBOUND_TX } }),
    countOf(Post, { author: uid, kind: { $ne: 'reel' } }),
    countOf(Post, { author: uid, kind: 'reel' }),
    countOf(Story, { author: uid }),
    creator ? countOf(Session, { creator: creator._id }) : 0,
    countOf(Booking, { user: uid }),
    countOf(Review, { toUser: uid }),
    countOf(Review, { fromUser: uid }),
    Review ? safe(() => Review.find({ toUser: uid, isHidden: { $ne: true } }).select('rating').limit(5000).lean(), []) : [],
    countOf(Community, { createdBy: uid }),
    countOf(Membership, { user: uid, status: 'active' }),
    brand ? countOf(Campaign, { brand: brand._id }) : 0,
    creator ? countOf(Application, { creator: creator._id }) : 0,
    creator ? countOf(Application, { creator: creator._id, status: 'accepted' }) : 0,
    sumField(Withdrawal, { user: uid, status: 'completed' }, 'netPayoutAmount'),
    sumField(Withdrawal, { user: uid, status: { $in: ['initiated', 'processing'] } }, 'amount'),
    countOf(StoreOrder, { buyer: uid, status: 'paid' }),
    countOf(StoreOrder, { seller: uid, status: 'paid' }),
    sumField(StoreOrder, { seller: uid, status: 'paid' }, 'amount'),
    countOf(ShopOrder, { buyer: uid }),
    countOf(AuthEvent, { user: uid, success: false, createdAt: { $gte: since30 } }),
    countOf(AuthEvent, { user: uid, success: true, createdAt: { $gte: since30 } }),
    Tx ? safe(() => Tx.find({ $or: [{ from: uid }, { to: uid }] }).sort({ createdAt: -1 }).limit(8).select('type status amount netAmount from to createdAt').lean(), []) : [],
  ]);
  const avg = receivedAvgRows.length ? receivedAvgRows.reduce((s, r) => s + r.rating, 0) / receivedAvgRows.length : null;

  return new ApiResponse(
    200,
    {
      user,
      profile: creator ? { kind: 'creator', ...creator } : brand ? { kind: 'brand', ...brand } : null,
      money: { earned, earnedCount, spent, spentCount, wallet: user.walletBalance || 0, withdrawnPaid, withdrawPending, storeSoldAmount },
      content: { posts, reels, stories, sessionsHosted, communitiesOwned },
      activity: { bookingsMade, communitiesJoined, campaigns, applications, applicationsAccepted, storeBought, storeSold, shopBought, logins30d: logins, failedLogins30d: failedLogins },
      reviews: { received: reviewsReceived, given: reviewsGiven, average: avg },
      recentTransactions: recentTx.map((t) => ({ ...t, direction: String(t.to) === String(uid) ? 'in' : 'out' })),
    },
    'User overview fetched'
  ).send(res);
});

module.exports = {
  listReviews,
  setReviewVisibility,
  listStories,
  deleteStory,
  listGifts,
  listSessions,
  sessionBookings,
  cancelSession,
  listBookings,
  listApplications,
  listWallets,
  listCommunityContent,
  removeCommunityContent,
  communityMembers,
  disputeHistory,
  listLegal,
  saveLegal,
  searchUsers,
  userOverview,
};