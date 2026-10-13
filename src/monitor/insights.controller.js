const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');

// Admin "Insights" API — leaderboards, finance, content and growth.
// Read-only and admins only (see monitor.routes.js). Everything is counted
// from the existing collections, so it includes the full history.

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
const safe = async (fn, fallback) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = 'Asia/Kolkata';
const INBOUND_TX = ['session_payment', 'donation', 'gift', 'campaign_escrow_deposit', 'campaign_posting_fee', 'subscription_payment', 'extra_proposal_fee', 'store_sale'];
const PAID = ['success', 'released', 'in_escrow'];
const OK = ['success', 'released'];

function clampDays(v, fallback = 30) {
  const n = Number(v);
  return [7, 14, 30, 60, 90, 180, 365].includes(n) ? n : fallback;
}
const since = (days) => new Date(Date.now() - days * DAY_MS);
const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
const lastDays = (days) => Array.from({ length: days }, (_, i) => dayKey(new Date(Date.now() - (days - 1 - i) * DAY_MS)));

/** [{ _id, v }] grouped by `by`, summing `field` (or counting). */
async function groupSum(model, match, by, field, { limit = 10, sort = -1 } = {}) {
  if (!model) return null;
  return safe(
    () =>
      model.aggregate([
        { $match: match },
        { $group: { _id: `$${by}`, v: field ? { $sum: `$${field}` } : { $sum: 1 } } },
        { $sort: { v: sort } },
        { $limit: limit },
      ]),
    []
  );
}

/** Per-day values for the last `days` days (IST). Falls back to bucketing in Node. */
async function daily(model, match, days, field = null, dateField = 'createdAt') {
  const keys = lastDays(days);
  const map = new Map(keys.map((k) => [k, 0]));
  if (!model) return null;
  const start = since(days);
  const rows = await safe(
    () =>
      model.aggregate([
        { $match: { ...match, [dateField]: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: `$${dateField}`, timezone: TZ } }, v: field ? { $sum: `$${field}` } : { $sum: 1 } } },
      ]),
    null
  );
  if (rows) rows.forEach((r) => map.has(r._id) && map.set(r._id, r.v));
  else {
    const docs = await safe(() => model.find({ ...match, [dateField]: { $gte: start } }).select(`${dateField} ${field || ''}`).limit(20000).lean(), []);
    docs.forEach((d) => {
      const k = dayKey(d[dateField]);
      if (map.has(k)) map.set(k, map.get(k) + (field ? d[field] || 0 : 1));
    });
  }
  return keys.map((date) => ({ date, value: map.get(date) || 0 }));
}

async function usersById(ids, select = 'name email avatarUrl role') {
  const User = M('User');
  if (!User || !ids.length) return new Map();
  const users = await safe(() => User.find({ _id: { $in: ids } }).select(select).lean(), []);
  return new Map(users.map((u) => [String(u._id), u]));
}

// ---------------------------------------------------------------------------
// GET /admin/monitor/leaderboards?days=30
// ---------------------------------------------------------------------------
const leaderboards = catchAsync(async (req, res) => {
  const days = clampDays(req.query.days, 30);
  const from = since(days);
  const Transaction = M('Transaction');
  const CreatorProfile = M('CreatorProfile');
  const BrandProfile = M('BrandProfile');
  const Post = M('Post');
  const Community = M('Community');
  const StoreOrder = M('StoreOrder');
  const Store = M('Store');

  const [earners, spenders, followed, viewed, posts, reels, communities, stores] = await Promise.all([
    groupSum(Transaction, { status: { $in: OK }, to: { $ne: null }, createdAt: { $gte: from } }, 'to', 'netAmount'),
    groupSum(Transaction, { status: { $in: PAID }, type: { $in: INBOUND_TX }, from: { $ne: null }, createdAt: { $gte: from } }, 'from', 'amount'),
    CreatorProfile ? safe(() => CreatorProfile.find().sort({ followerCount: -1 }).limit(10).select('user slug followerCount averageRating profileViews').populate('user', 'name avatarUrl email').lean(), []) : null,
    CreatorProfile ? safe(() => CreatorProfile.find().sort({ profileViews: -1 }).limit(10).select('user slug profileViews').populate('user', 'name avatarUrl email').lean(), []) : null,
    Post ? safe(() => Post.find({ kind: { $ne: 'reel' }, createdAt: { $gte: from } }).sort({ likeCount: -1 }).limit(10).select('caption likeCount mediaItems author createdAt').populate('author', 'name avatarUrl').lean(), []) : null,
    Post ? safe(() => Post.find({ kind: 'reel', createdAt: { $gte: from } }).sort({ viewCount: -1 }).limit(10).select('caption likeCount viewCount mediaItems author createdAt').populate('author', 'name avatarUrl').lean(), []) : null,
    Community ? safe(() => Community.find().sort({ memberCount: -1 }).limit(10).select('name slug memberCount createdBy').populate('createdBy', 'name avatarUrl').lean(), []) : null,
    groupSum(StoreOrder, { status: 'paid', createdAt: { $gte: from } }, 'store', 'amount'),
  ]);

  const people = await usersById([...(earners || []), ...(spenders || [])].map((r) => r._id).filter(Boolean));
  const brandsByUser = BrandProfile && spenders?.length ? new Map((await safe(() => BrandProfile.find({ user: { $in: spenders.map((s) => s._id) } }).select('user companyName').lean(), [])).map((b) => [String(b.user), b.companyName])) : new Map();
  const storeDocs = Store && stores?.length ? new Map((await safe(() => Store.find({ _id: { $in: stores.map((s) => s._id) } }).select('name slug').lean(), [])).map((s) => [String(s._id), s])) : new Map();

  const person = (r) => {
    const u = people.get(String(r._id)) || {};
    return { userId: r._id, name: brandsByUser.get(String(r._id)) || u.name || 'Unknown', email: u.email || '', avatarUrl: u.avatarUrl || '', role: u.role || '', value: r.v };
  };

  return new ApiResponse(
    200,
    {
      days,
      topEarners: earners ? earners.map(person) : null,
      topSpenders: spenders ? spenders.map(person) : null,
      mostFollowed: followed ? followed.map((c) => ({ userId: c.user?._id, name: c.user?.name || c.slug, email: c.user?.email || '', avatarUrl: c.user?.avatarUrl || '', slug: c.slug, value: c.followerCount || 0, rating: c.averageRating || 0 })) : null,
      mostViewed: viewed ? viewed.map((c) => ({ userId: c.user?._id, name: c.user?.name || c.slug, email: c.user?.email || '', avatarUrl: c.user?.avatarUrl || '', slug: c.slug, value: c.profileViews || 0 })) : null,
      topPosts: posts ? posts.map((p) => ({ id: p._id, caption: p.caption || '', value: p.likeCount || 0, thumb: p.mediaItems?.[0]?.type === 'image' ? p.mediaItems[0].url : p.mediaItems?.[0]?.thumbnailUrl || '', author: p.author?.name || '', authorId: p.author?._id, avatarUrl: p.author?.avatarUrl || '', createdAt: p.createdAt })) : null,
      topReels: reels ? reels.map((p) => ({ id: p._id, caption: p.caption || '', value: p.viewCount || 0, likes: p.likeCount || 0, thumb: p.mediaItems?.[0]?.thumbnailUrl || '', author: p.author?.name || '', authorId: p.author?._id, avatarUrl: p.author?.avatarUrl || '', createdAt: p.createdAt })) : null,
      topCommunities: communities ? communities.map((c) => ({ id: c._id, name: c.name, slug: c.slug, value: c.memberCount || 0, owner: c.createdBy?.name || '' })) : null,
      topStores: stores ? stores.map((s) => ({ id: s._id, name: storeDocs.get(String(s._id))?.name || 'Store', slug: storeDocs.get(String(s._id))?.slug || '', value: s.v })) : null,
    },
    'Leaderboards fetched'
  ).send(res);
});

// ---------------------------------------------------------------------------
// GET /admin/monitor/finance?days=30
// ---------------------------------------------------------------------------
const finance = catchAsync(async (req, res) => {
  const days = clampDays(req.query.days, 30);
  const from = since(days);
  const Transaction = M('Transaction');
  const Withdrawal = M('Withdrawal');
  const StoreOrder = M('StoreOrder');
  const ShopOrder = M('ShopOrder');

  const inbound = { status: { $in: PAID }, type: { $in: INBOUND_TX } };
  const [byType, commissionByType, moneyIn, commission, payouts, refunds, failed, statusMix, payoutsPaid, payoutsPending, storeSales, shopSales] = await Promise.all([
    groupSum(Transaction, { ...inbound, createdAt: { $gte: from } }, 'type', 'amount', { limit: 20 }),
    groupSum(Transaction, { status: { $in: OK }, platformCommission: { $gt: 0 }, createdAt: { $gte: from } }, 'type', 'platformCommission', { limit: 20 }),
    daily(Transaction, inbound, days, 'amount'),
    daily(Transaction, { status: { $in: OK } }, days, 'platformCommission'),
    daily(Withdrawal, { status: 'completed' }, days, 'netPayoutAmount'),
    groupSum(Transaction, { status: 'refunded', createdAt: { $gte: from } }, 'type', 'amount', { limit: 20 }),
    groupSum(Transaction, { status: 'failed', createdAt: { $gte: from } }, 'type', null, { limit: 20 }),
    groupSum(Transaction, { createdAt: { $gte: from } }, 'status', null, { limit: 10 }),
    groupSum(Withdrawal, { status: 'completed', createdAt: { $gte: from } }, 'status', 'netPayoutAmount'),
    groupSum(Withdrawal, { status: { $in: ['initiated', 'processing'] } }, 'status', 'amount'),
    groupSum(StoreOrder, { status: 'paid', createdAt: { $gte: from } }, 'itemType', 'amount'),
    groupSum(ShopOrder, { status: { $nin: ['awaiting_payment', 'payment_failed', 'cancelled'] }, createdAt: { $gte: from } }, 'status', 'total'),
  ]);

  // Last 12 calendar months (IST) for the monthly report.
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i -= 1) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    months.push({ key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`, start, end });
  }
  const sumIn = async (model, match, field) => {
    if (!model) return null;
    const r = await safe(() => model.aggregate([{ $match: match }, { $group: { _id: null, v: { $sum: `$${field}` } } }]), []);
    return r[0]?.v || 0;
  };
  const monthly = await Promise.all(
    months.map(async (m) => {
      const range = { createdAt: { $gte: m.start, $lt: m.end } };
      const [inAmt, comm, out, ref, store] = await Promise.all([
        sumIn(Transaction, { ...inbound, ...range }, 'amount'),
        sumIn(Transaction, { status: { $in: OK }, ...range }, 'platformCommission'),
        sumIn(Withdrawal, { status: 'completed', ...range }, 'netPayoutAmount'),
        sumIn(Transaction, { status: 'refunded', ...range }, 'amount'),
        sumIn(StoreOrder, { status: 'paid', ...range }, 'amount'),
      ]);
      return { month: m.key, moneyIn: inAmt, commission: comm, payouts: out, refunds: ref, storeSales: store };
    })
  );

  const total = (rows) => (rows ? rows.reduce((n, r) => n + (r.v || 0), 0) : null);
  return new ApiResponse(
    200,
    {
      days,
      totals: {
        moneyIn: total(byType),
        commission: total(commissionByType),
        payoutsPaid: total(payoutsPaid),
        payoutsPending: total(payoutsPending),
        refunds: total(refunds),
        failedPayments: total(failed),
        storeSales: total(storeSales),
        shopSales: total(shopSales),
      },
      byType: byType ? byType.map((r) => ({ type: r._id, amount: r.v })) : null,
      commissionByType: commissionByType ? commissionByType.map((r) => ({ type: r._id, amount: r.v })) : null,
      refundsByType: refunds ? refunds.map((r) => ({ type: r._id, amount: r.v })) : null,
      failedByType: failed ? failed.map((r) => ({ type: r._id, count: r.v })) : null,
      statusMix: statusMix ? statusMix.map((r) => ({ status: r._id, count: r.v })) : null,
      storeByItem: storeSales ? storeSales.map((r) => ({ type: r._id, amount: r.v })) : null,
      series: { moneyIn, commission, payouts },
      monthly,
    },
    'Finance fetched'
  ).send(res);
});

// ---------------------------------------------------------------------------
// GET /admin/monitor/content?days=30
// ---------------------------------------------------------------------------
const content = catchAsync(async (req, res) => {
  const days = clampDays(req.query.days, 30);
  const from = since(days);
  const Post = M('Post');
  const Story = M('Story');
  const CommunityPost = M('CommunityPost');
  const Review = M('Review');

  const [posts, reels, stories, communityPosts, likes, views, topPosters, storiesLive, reviewsAvg, ratingMix] = await Promise.all([
    daily(Post, { kind: { $ne: 'reel' } }, days),
    daily(Post, { kind: 'reel' }, days),
    daily(Story, {}, days),
    daily(CommunityPost, {}, days),
    groupSum(Post, { createdAt: { $gte: from } }, 'kind', 'likeCount', { limit: 5 }),
    groupSum(Post, { kind: 'reel', createdAt: { $gte: from } }, 'kind', 'viewCount', { limit: 5 }),
    groupSum(Post, { createdAt: { $gte: from } }, 'author', null, { limit: 10 }),
    Story ? safe(() => Story.countDocuments({ expiresAt: { $gt: new Date() } }), null) : null,
    groupSum(Review, { createdAt: { $gte: from } }, 'rating', null, { limit: 5 }),
    groupSum(Review, {}, 'rating', null, { limit: 5 }),
  ]);
  const people = await usersById((topPosters || []).map((r) => r._id).filter(Boolean));
  const sum = (s) => (s ? s.reduce((n, p) => n + p.value, 0) : null);
  const totalPosts = sum(posts);
  const totalReels = sum(reels);
  const likeTotal = likes ? likes.reduce((n, r) => n + r.v, 0) : null;

  return new ApiResponse(
    200,
    {
      days,
      totals: {
        posts: totalPosts,
        reels: totalReels,
        stories: sum(stories),
        communityPosts: sum(communityPosts),
        storiesLive,
        likes: likeTotal,
        reelViews: views ? views.reduce((n, r) => n + r.v, 0) : null,
        avgLikesPerPost: likeTotal !== null && (totalPosts || 0) + (totalReels || 0) > 0 ? likeTotal / ((totalPosts || 0) + (totalReels || 0)) : null,
      },
      series: { posts, reels, stories, communityPosts },
      topPosters: topPosters ? topPosters.map((r) => ({ userId: r._id, name: people.get(String(r._id))?.name || 'Unknown', avatarUrl: people.get(String(r._id))?.avatarUrl || '', role: people.get(String(r._id))?.role || '', value: r.v })) : null,
      reviews: { period: reviewsAvg ? reviewsAvg.map((r) => ({ rating: r._id, count: r.v })) : null, allTime: ratingMix ? ratingMix.map((r) => ({ rating: r._id, count: r.v })) : null },
    },
    'Content stats fetched'
  ).send(res);
});

// ---------------------------------------------------------------------------
// GET /admin/monitor/growth?days=30 — sign-up funnel and sign-up mix
// ---------------------------------------------------------------------------
const growth = catchAsync(async (req, res) => {
  const days = clampDays(req.query.days, 30);
  const from = since(days);
  const User = M('User');
  const CreatorProfile = M('CreatorProfile');
  const BrandProfile = M('BrandProfile');
  const Post = M('Post');
  const Transaction = M('Transaction');

  // People who signed up in the period (capped to keep this fast).
  const signups = User ? await safe(() => User.find({ createdAt: { $gte: from }, role: { $ne: 'admin' } }).select('_id role authProvider onboardingCompleted lastLoginAt').limit(50000).lean(), []) : [];
  const ids = signups.map((u) => u._id);
  const creatorIds = signups.filter((u) => u.role === 'creator').map((u) => u._id);
  const brandIds = signups.filter((u) => u.role === 'brand').map((u) => u._id);

  const [verifiedCreators, verifiedBrands, posted, earned, paid, byRole, byMethod, series] = await Promise.all([
    CreatorProfile && creatorIds.length ? safe(() => CreatorProfile.countDocuments({ user: { $in: creatorIds }, verificationStatus: 'verified' }), 0) : 0,
    BrandProfile && brandIds.length ? safe(() => BrandProfile.countDocuments({ user: { $in: brandIds }, verificationStatus: 'verified' }), 0) : 0,
    Post && ids.length ? safe(async () => (await Post.distinct('author', { author: { $in: ids } })).length, 0) : 0,
    Transaction && ids.length ? safe(async () => (await Transaction.distinct('to', { to: { $in: ids }, status: { $in: OK } })).length, 0) : 0,
    Transaction && ids.length ? safe(async () => (await Transaction.distinct('from', { from: { $in: ids }, status: { $in: PAID }, type: { $in: INBOUND_TX } })).length, 0) : 0,
    groupSum(User, { createdAt: { $gte: from }, role: { $ne: 'admin' } }, 'role', null),
    groupSum(User, { createdAt: { $gte: from }, role: { $ne: 'admin' } }, 'authProvider', null),
    daily(User, { role: { $ne: 'admin' } }, days),
  ]);

  const total = signups.length;
  const onboarded = signups.filter((u) => u.onboardingCompleted).length;
  const cameBack = signups.filter((u) => u.lastLoginAt && new Date(u.lastLoginAt) - new Date(from) > 0).length;
  const professionals = creatorIds.length + brandIds.length;

  return new ApiResponse(
    200,
    {
      days,
      funnel: [
        { key: 'signed_up', label: 'Signed up', count: total },
        { key: 'onboarded', label: 'Finished onboarding', count: onboarded },
        { key: 'verified', label: 'Profile verified (creators & brands)', count: verifiedCreators + verifiedBrands, of: professionals },
        { key: 'posted', label: 'Published a post or reel', count: posted },
        { key: 'paid', label: 'Paid for something', count: paid },
        { key: 'earned', label: 'Earned money', count: earned },
      ],
      cameBack,
      byRole: byRole ? byRole.map((r) => ({ role: r._id, count: r.v })) : null,
      byMethod: byMethod ? byMethod.map((r) => ({ method: r._id || 'local', count: r.v })) : null,
      series,
    },
    'Growth fetched'
  ).send(res);
});

module.exports = { leaderboards, finance, content, growth };