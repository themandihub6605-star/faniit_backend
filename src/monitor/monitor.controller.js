// File: src/monitor/monitor.controller.js
const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const { AdminAuditLog, AuthEvent, ApiIssue, ApiTraffic } = require('./models');

// Admin "Monitor" API — everything the new admin dashboard, Activity and
// System health pages show. Read-only, admins only (see monitor.routes.js).
// Every number here is counted from the real collections; nothing is made up.

const M = (name) => {
  try {
    return mongoose.model(name);
  } catch {
    return null; // model not loaded in this backend → that metric is reported as unavailable
  }
};
// Make sure the core models are registered.
require('../models');
try {
  require('../FanittStore/models');
} catch {
  /* store module not installed */
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = 'Asia/Kolkata';
const PAID_TX = ['success', 'released', 'in_escrow'];
// Money coming INTO the platform (commission/payout rows are internal splits).
const INBOUND_TX = ['session_payment', 'donation', 'gift', 'campaign_escrow_deposit', 'campaign_posting_fee', 'subscription_payment', 'extra_proposal_fee'];

function clampDays(v, fallback = 30) {
  const n = Number(v);
  return [1, 7, 14, 30, 60, 90, 180, 365].includes(n) ? n : fallback;
}

function range(days) {
  const now = new Date();
  const start = new Date(now.getTime() - days * DAY_MS);
  const prevStart = new Date(start.getTime() - days * DAY_MS);
  return { now, start, prevStart };
}

function page(q, def = 25, max = 100) {
  const limit = Math.min(max, Math.max(1, Number(q.limit) || def));
  const p = Math.max(1, Number(q.page) || 1);
  return { page: p, limit, skip: (p - 1) * limit };
}

const safe = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

const count = (model, filter) => (model ? safe(() => model.countDocuments(filter), null) : Promise.resolve(null));

async function sum(model, match, field) {
  if (!model) return null;
  return safe(async () => {
    const r = await model.aggregate([{ $match: match }, { $group: { _id: null, v: { $sum: `$${field}` } } }]);
    return r[0]?.v || 0;
  }, null);
}

const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD in IST

function emptyDays(start, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(dayKey(new Date(Date.now() - i * DAY_MS)));
  return out;
}

/** Per-day count (or sum of `field`) for the last `days` days, IST days. */
async function series(model, match, days, { dateField = 'createdAt', field = null } = {}) {
  const keys = emptyDays(new Date(), days);
  if (!model) return null;
  const start = new Date(Date.now() - days * DAY_MS);
  const map = new Map(keys.map((k) => [k, 0]));
  const rows = await safe(
    () =>
      model.aggregate([
        { $match: { ...match, [dateField]: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: `$${dateField}`, timezone: TZ } }, v: field ? { $sum: `$${field}` } : { $sum: 1 } } },
      ]),
    null
  );
  if (rows) {
    rows.forEach((r) => map.has(r._id) && map.set(r._id, r.v));
  } else {
    // Fallback for databases without $dateToString: bucket in Node (capped).
    const docs = await safe(() => model.find({ ...match, [dateField]: { $gte: start } }).select(`${dateField} ${field || ''}`).limit(20000).lean(), []);
    docs.forEach((d) => {
      const k = dayKey(d[dateField]);
      if (map.has(k)) map.set(k, map.get(k) + (field ? d[field] || 0 : 1));
    });
  }
  return keys.map((date) => ({ date, value: map.get(date) || 0 }));
}

const cmp = (cur, prev) => ({ current: cur, previous: prev });


/** Things waiting for an admin, most urgent first. `payoutsAmount` is optional. */
async function attentionList(payoutsAmount) {
  const now = new Date();
  const CreatorProfile = M('CreatorProfile');
  const BrandProfile = M('BrandProfile');
  const Withdrawal = M('Withdrawal');
  const User = M('User');
  const Campaign = M('Campaign');
  const Dispute = M('Dispute');
  const Review = M('Review');
  const Store = M('Store');
  const Report = M('Report');
  const payoutsPendingAmount = payoutsAmount === undefined ? await sum(Withdrawal, { status: { $in: ['initiated', 'processing'] } }, 'amount') : payoutsAmount;
  // Things waiting for an admin, most urgent first.
  const [pendingCreators, pendingBrands, wInitiated, wProcessing, deletions, campaignReview, disputes, disputedCampaigns, flagged, storeKyc, issues24h, reports] = await Promise.all([
    count(CreatorProfile, { verificationStatus: 'pending' }),
    count(BrandProfile, { verificationStatus: 'pending' }),
    count(Withdrawal, { status: 'initiated' }),
    count(Withdrawal, { status: 'processing' }),
    count(User, { deletionStatus: 'pending' }),
    count(Campaign, { approvalStatus: 'pending' }),
    count(Dispute, { status: 'open' }),
    count(Campaign, { status: 'disputed' }),
    count(Review, { isFlagged: true, isHidden: { $ne: true } }),
    count(Store, { status: 'pending_review' }),
    count(ApiIssue, { lastSeenAt: { $gte: new Date(now - DAY_MS) }, resolvedAt: null }),
    count(Report, { status: 'pending' }),
  ]);

  return [
    { key: 'reports', label: 'Reported content to review', count: reports, href: '/reports', tone: 'rose' },
    { key: 'verifications', label: 'Profiles waiting for approval', count: (pendingCreators ?? 0) + (pendingBrands ?? 0), href: '/verifications', tone: 'amber' },
    { key: 'withdrawals', label: 'Withdrawal requests to pay', count: (wInitiated ?? 0) + (wProcessing ?? 0), href: '/withdrawals', tone: 'rose', amount: payoutsPendingAmount },
    { key: 'campaigns', label: 'Campaigns waiting for review', count: campaignReview, href: '/campaigns', tone: 'sky' },
    { key: 'disputes', label: 'Open payment disputes', count: (disputes ?? 0) + (disputedCampaigns ?? 0), href: '/escrow-disputes', tone: 'rose' },
    { key: 'deletions', label: 'Account deletion requests', count: deletions, href: '/account-deletions', tone: 'gray' },
    { key: 'store-kyc', label: 'Stores waiting for KYC review', count: storeKyc, href: '/store/stores', tone: 'amber' },
    { key: 'reviews', label: 'Flagged reviews', count: flagged, href: '/moderation', tone: 'amber' },
    { key: 'api', label: 'API problems in the last 24h', count: issues24h, href: '/system', tone: 'rose' },
  ].filter((a) => a.count !== null);
}



// ---------------------------------------------------------------------------
// GET /admin/monitor/overview?days=30
// ---------------------------------------------------------------------------
const overview = catchAsync(async (req, res) => {
  const days = clampDays(req.query.days, 30);
  const { now, start, prevStart } = range(days);
  const cur = { createdAt: { $gte: start, $lte: now } };
  const prev = { createdAt: { $gte: prevStart, $lt: start } };

  const User = M('User');
  const Post = M('Post');
  const Story = M('Story');
  const CommunityPost = M('CommunityPost');
  const Community = M('Community');
  const Campaign = M('Campaign');
  const Session = M('Session');
  const Transaction = M('Transaction');
  const Withdrawal = M('Withdrawal');
  const CreatorProfile = M('CreatorProfile');
  const BrandProfile = M('BrandProfile');
  const Review = M('Review');
  const Dispute = M('Dispute');
  const ScreenEvent = M('ScreenEvent');
  const Store = M('Store');
  const StoreOrder = M('StoreOrder');
  const ShopOrder = M('ShopOrder');
  const UserSubscription = M('UserSubscription');

  const paidIn = { status: { $in: PAID_TX }, type: { $in: INBOUND_TX } };
  const okTx = { status: { $in: ['success', 'released'] } };
  const shopValid = { status: { $nin: ['awaiting_payment', 'payment_failed', 'cancelled'] } };

  const [
    usersTotal,
    usersNew,
    usersNewPrev,
    creators,
    brands,
    fans,
    agencies,
    suspended,
    active1,
    active7,
    active30,
    activePrev,
    appVisitors,
    posts,
    postsPrev,
    reels,
    reelsPrev,
    storiesLive,
    communityPosts,
    communityPostsPrev,
    communitiesTotal,
    communitiesNew,
    campaignsTotal,
    campaignsNew,
    campaignsNewPrev,
    sessionsUpcoming,
    sessionsNew,
    gmv,
    gmvPrev,
    commission,
    commissionPrev,
    txFailed,
    txFailedPrev,
    refunds,
    escrow,
    payoutsPendingAmount,
    activeSubs,
    storesActive,
    storeOrders,
    storeOrdersPrev,
    storeRevenue,
    shopOrders,
    shopOrdersPrev,
    shopRevenue,
  ] = await Promise.all([
    count(User, {}),
    count(User, cur),
    count(User, prev),
    count(User, { role: 'creator' }),
    count(User, { role: 'brand' }),
    count(User, { role: 'fan' }),
    count(User, { role: 'agency' }),
    count(User, { isSuspended: true }),
    count(User, { lastLoginAt: { $gte: new Date(now - DAY_MS) } }),
    count(User, { lastLoginAt: { $gte: new Date(now - 7 * DAY_MS) } }),
    count(User, { lastLoginAt: { $gte: start } }),
    count(User, { lastLoginAt: { $gte: prevStart, $lt: start } }),
    ScreenEvent ? safe(async () => (await ScreenEvent.distinct('visitor', { startedAt: { $gte: start } })).length, null) : null,
    count(Post, { ...cur, kind: { $ne: 'reel' } }),
    count(Post, { ...prev, kind: { $ne: 'reel' } }),
    count(Post, { ...cur, kind: 'reel' }),
    count(Post, { ...prev, kind: 'reel' }),
    count(Story, { expiresAt: { $gt: now } }),
    count(CommunityPost, cur),
    count(CommunityPost, prev),
    count(Community, {}),
    count(Community, cur),
    count(Campaign, {}),
    count(Campaign, cur),
    count(Campaign, prev),
    count(Session, { scheduledAt: { $gte: now }, isCancelled: { $ne: true } }),
    count(Session, cur),
    sum(Transaction, { ...paidIn, ...cur }, 'amount'),
    sum(Transaction, { ...paidIn, ...prev }, 'amount'),
    sum(Transaction, { ...okTx, ...cur }, 'platformCommission'),
    sum(Transaction, { ...okTx, ...prev }, 'platformCommission'),
    count(Transaction, { ...cur, status: 'failed' }),
    count(Transaction, { ...prev, status: 'failed' }),
    count(Transaction, { ...cur, status: 'refunded' }),
    sum(Transaction, { status: 'in_escrow' }, 'amount'),
    sum(Withdrawal, { status: { $in: ['initiated', 'processing'] } }, 'amount'),
    count(UserSubscription, { status: 'active' }),
    count(Store, { status: 'active' }),
    count(StoreOrder, { ...cur, status: 'paid' }),
    count(StoreOrder, { ...prev, status: 'paid' }),
    sum(StoreOrder, { ...cur, status: 'paid' }, 'amount'),
    count(ShopOrder, { ...cur, ...shopValid }),
    count(ShopOrder, { ...prev, ...shopValid }),
    sum(ShopOrder, { ...cur, ...shopValid }, 'total'),
  ]);

  const attention = await attentionList(payoutsPendingAmount);

  const [signupSeries, revenueSeries, loginSeries, postSeries, recentAdmin, traffic24, trackingAudit, trackingAuth, trackingApi] = await Promise.all([
    series(User, {}, days),
    series(Transaction, paidIn, days, { field: 'amount' }),
    series(AuthEvent, { success: true }, days),
    series(Post, {}, days),
    AdminAuditLog.find().sort({ createdAt: -1 }).limit(8).lean(),
    ApiTraffic.find({ hour: { $gte: new Date(now - DAY_MS) } }).lean(),
    AdminAuditLog.findOne().sort({ createdAt: 1 }).select('createdAt').lean(),
    AuthEvent.findOne().sort({ createdAt: 1 }).select('createdAt').lean(),
    ApiTraffic.findOne().sort({ hour: 1 }).select('hour').lean(),
  ]);

  const t = traffic24.reduce((a, r) => ({ total: a.total + r.total, s5xx: a.s5xx + r.s5xx, s4xx: a.s4xx + r.s4xx, ms: a.ms + r.totalMs }), { total: 0, s5xx: 0, s4xx: 0, ms: 0 });

  return new ApiResponse(
    200,
    {
      period: { days, start, end: now },
      users: {
        total: usersTotal,
        new: cmp(usersNew, usersNewPrev),
        byRole: { creator: creators, brand: brands, fan: fans, agency: agencies },
        suspended,
        active: { day: active1, week: active7, period: cmp(active30, activePrev) },
        appVisitors,
      },
      content: {
        posts: cmp(posts, postsPrev),
        reels: cmp(reels, reelsPrev),
        storiesLive,
        communityPosts: cmp(communityPosts, communityPostsPrev),
        communities: { total: communitiesTotal, new: communitiesNew },
      },
      business: {
        campaigns: { total: campaignsTotal, ...cmp(campaignsNew, campaignsNewPrev) },
        sessions: { upcoming: sessionsUpcoming, created: sessionsNew },
        activeSubscriptions: activeSubs,
      },
      money: {
        gmv: cmp(gmv, gmvPrev),
        commission: cmp(commission, commissionPrev),
        failedPayments: cmp(txFailed, txFailedPrev),
        refunds,
        inEscrow: escrow,
        pendingPayouts: payoutsPendingAmount,
      },
      store: {
        activeStores: storesActive,
        digitalOrders: cmp(storeOrders, storeOrdersPrev),
        digitalRevenue: storeRevenue,
        shopOrders: cmp(shopOrders, shopOrdersPrev),
        shopRevenue,
      },
      attention,
      series: { signups: signupSeries, revenue: revenueSeries, logins: loginSeries, posts: postSeries },
      api: {
        requests24h: t.total,
        errors24h: t.s5xx,
        clientErrors24h: t.s4xx,
        errorRate: t.total ? t.s5xx / t.total : null,
        avgMs: t.total ? Math.round(t.ms / t.total) : null,
        openIssues: attention.find((a) => a.key === 'api')?.count ?? null,
      },
      recentAdmin,
      trackingSince: {
        adminActions: trackingAudit?.createdAt || null,
        logins: trackingAuth?.createdAt || null,
        api: trackingApi?.hour || null,
      },
    },
    'Overview fetched'
  ).send(res);
});

// ---------------------------------------------------------------------------
// GET /admin/monitor/activity?type=&days=&page=&limit=
// One timeline of what's happening on the platform, newest first.
// ---------------------------------------------------------------------------

const money = (paise) => `₹${Math.round((paise || 0) / 100).toLocaleString('en-IN')}`;

const SOURCES = {
  signup: {
    label: 'Sign-ups',
    model: 'User',
    query: (m, f, n) => m.find(f).sort({ createdAt: -1 }).limit(n).select('name email role createdAt avatarUrl').lean(),
    map: (u) => ({ title: `${u.name || 'Someone'} joined as ${u.role}`, actor: { name: u.name, avatarUrl: u.avatarUrl, id: u._id }, href: `/users/${u._id}`, tone: 'emerald' }),
  },
  login: {
    label: 'Logins',
    model: 'AuthEvent',
    filter: { success: true },
    query: (m, f, n) => m.find(f).sort({ createdAt: -1 }).limit(n).lean(),
    map: (e) => ({ title: `${e.name || e.email || 'Someone'} logged in${e.client && e.client !== 'unknown' ? ` on the ${e.client}` : ''}`, meta: e.action, actor: { name: e.name, id: e.user }, href: e.user ? `/users/${e.user}` : null, tone: 'sky' }),
  },
  failed_login: {
    label: 'Failed logins',
    model: 'AuthEvent',
    filter: { success: false },
    query: (m, f, n) => m.find(f).sort({ createdAt: -1 }).limit(n).lean(),
    map: (e) => ({ title: `Failed login${e.email ? ` for ${e.email}` : ''}`, meta: e.reason, href: null, tone: 'rose' }),
  },
  post: {
    label: 'Posts & reels',
    model: 'Post',
    query: (m, f, n) => m.find(f).sort({ createdAt: -1 }).limit(n).select('kind caption author createdAt mediaItems').populate('author', 'name avatarUrl').lean(),
    map: (p) => ({
      title: `${p.author?.name || 'Someone'} published a ${p.kind === 'reel' ? 'reel' : 'post'}`,
      meta: p.caption ? p.caption.slice(0, 90) : '',
      actor: { name: p.author?.name, avatarUrl: p.author?.avatarUrl, id: p.author?._id },
      thumb: p.mediaItems?.[0]?.type === 'image' ? p.mediaItems[0].url : p.mediaItems?.[0]?.thumbnailUrl || '',
      href: '/posts',
      tone: 'pink',
    }),
  },
  community_post: {
    label: 'Community posts',
    model: 'CommunityPost',
    query: (m, f, n) => m.find(f).sort({ createdAt: -1 }).limit(n).select('author community content text createdAt').populate('author', 'name avatarUrl').populate('community', 'name').lean(),
    map: (p) => ({
      title: `${p.author?.name || 'Someone'} posted in ${p.community?.name || 'a community'}`,
      meta: String(p.content || p.text || '').slice(0, 90),
      actor: { name: p.author?.name, avatarUrl: p.author?.avatarUrl, id: p.author?._id },
      href: '/posts',
      tone: 'pink',
    }),
  },
  community: {
    label: 'New communities',
    model: 'Community',
    query: (m, f, n) => m.find(f).sort({ createdAt: -1 }).limit(n).select('name createdBy createdAt').populate('createdBy', 'name avatarUrl').lean(),
    map: (c) => ({ title: `${c.createdBy?.name || 'Someone'} created the community "${c.name}"`, actor: { name: c.createdBy?.name, avatarUrl: c.createdBy?.avatarUrl, id: c.createdBy?._id }, href: '/communities', tone: 'orange' }),
  },
  campaign: {
    label: 'Campaigns',
    model: 'Campaign',
    query: (m, f, n) => m.find(f).sort({ createdAt: -1 }).limit(n).select('title budget status approvalStatus brand createdAt').populate('brand', 'companyName').lean(),
    map: (c) => ({ title: `${c.brand?.companyName || 'A brand'} created the campaign "${c.title}"`, meta: `${money(c.budget)} · ${c.approvalStatus === 'pending' ? 'waiting for review' : c.status}`, href: '/campaigns', tone: 'amber' }),
  },
  payment: {
    label: 'Payments',
    model: 'Transaction',
    filter: { type: { $in: INBOUND_TX } },
    query: (m, f, n) => m.find(f).sort({ createdAt: -1 }).limit(n).select('type status amount from createdAt').populate('from', 'name avatarUrl').lean(),
    map: (t) => ({
      title: `${t.from?.name || 'Someone'} paid ${money(t.amount)} · ${String(t.type).replace(/_/g, ' ')}`,
      meta: t.status,
      actor: { name: t.from?.name, avatarUrl: t.from?.avatarUrl, id: t.from?._id },
      href: '/transactions',
      tone: t.status === 'failed' ? 'rose' : 'emerald',
    }),
  },
  withdrawal: {
    label: 'Withdrawals',
    model: 'Withdrawal',
    query: (m, f, n) => m.find(f).sort({ createdAt: -1 }).limit(n).select('amount status user createdAt').populate('user', 'name avatarUrl').lean(),
    map: (w) => ({ title: `${w.user?.name || 'Someone'} asked to withdraw ${money(w.amount)}`, meta: w.status, actor: { name: w.user?.name, avatarUrl: w.user?.avatarUrl, id: w.user?._id }, href: '/withdrawals', tone: 'orange' }),
  },
  review: {
    label: 'Reviews',
    model: 'Review',
    query: (m, f, n) => m.find(f).sort({ createdAt: -1 }).limit(n).select('rating comment fromUser toUser createdAt isFlagged').populate('fromUser', 'name avatarUrl').populate('toUser', 'name').lean(),
    map: (r) => ({
      title: `${r.fromUser?.name || 'Someone'} rated ${r.toUser?.name || 'a creator'} ${r.rating}★`,
      meta: r.comment ? r.comment.slice(0, 90) : '',
      actor: { name: r.fromUser?.name, avatarUrl: r.fromUser?.avatarUrl, id: r.fromUser?._id },
      href: '/moderation',
      tone: r.isFlagged ? 'rose' : 'amber',
    }),
  },
  store_order: {
    label: 'Store orders',
    model: 'StoreOrder',
    filter: { status: 'paid' },
    query: (m, f, n) => m.find(f).sort({ createdAt: -1 }).limit(n).select('itemTitle itemType amount buyer createdAt').populate('buyer', 'name avatarUrl').lean(),
    map: (o) => ({ title: `${o.buyer?.name || 'Someone'} bought "${o.itemTitle}"`, meta: `${money(o.amount)} · ${o.itemType}`, actor: { name: o.buyer?.name, avatarUrl: o.buyer?.avatarUrl, id: o.buyer?._id }, href: '/store/orders', tone: 'emerald' }),
  },
  shop_order: {
    label: 'Shop orders',
    model: 'ShopOrder',
    query: (m, f, n) => m.find(f).sort({ createdAt: -1 }).limit(n).select('orderNumber total status buyer createdAt').populate('buyer', 'name avatarUrl').lean(),
    map: (o) => ({ title: `${o.buyer?.name || 'Someone'} placed order ${o.orderNumber}`, meta: `${money(o.total)} · ${String(o.status).replace(/_/g, ' ')}`, actor: { name: o.buyer?.name, avatarUrl: o.buyer?.avatarUrl, id: o.buyer?._id }, href: '/store/shop', tone: 'emerald' }),
  },
  admin: {
    label: 'Admin actions',
    model: 'AdminAuditLog',
    query: (m, f, n) => m.find(f).sort({ createdAt: -1 }).limit(n).lean(),
    map: (a) => ({ title: `${a.actorName || 'An admin'}: ${a.message || `${a.method} ${a.path.replace('/api', '')}`}`, meta: a.success ? '' : `Failed (${a.status})`, actor: { name: a.actorName, id: a.actor }, href: '/activity?tab=audit', tone: a.success ? 'gray' : 'rose' }),
  },
};

const activity = catchAsync(async (req, res) => {
  const days = clampDays(req.query.days, 7);
  const { limit, page: p } = page(req.query, 30, 100);
  const since = new Date(Date.now() - days * DAY_MS);
  const wanted = String(req.query.type || '')
    .split(',')
    .filter((t) => SOURCES[t]);
  const keys = wanted.length ? wanted : Object.keys(SOURCES).filter((k) => k !== 'login'); // logins are noisy — opt-in
  const need = p * limit;

  const results = await Promise.all(
    keys.map(async (key) => {
      const s = SOURCES[key];
      const model = M(s.model);
      if (!model) return { key, available: false, total: 0, items: [] };
      const filter = { ...(s.filter || {}), createdAt: { $gte: since } };
      const [docs, total] = await Promise.all([safe(() => s.query(model, filter, need), []), safe(() => model.countDocuments(filter), 0)]);
      return {
        key,
        available: true,
        total,
        items: docs.map((d) => ({ id: `${key}:${d._id}`, type: key, at: d.createdAt, ...s.map(d) })),
      };
    })
  );

  const merged = results
    .flatMap((r) => r.items)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice((p - 1) * limit, p * limit);
  const total = results.reduce((n, r) => n + r.total, 0);

  return new ApiResponse(
    200,
    {
      items: merged,
      page: p,
      limit,
      total,
      hasMore: p * limit < total,
      days,
      sources: Object.entries(SOURCES).map(([key, s]) => {
        const r = results.find((x) => x.key === key);
        return { key, label: s.label, count: r ? r.total : null, available: r ? r.available : M(s.model) !== null };
      }),
    },
    'Activity fetched'
  ).send(res);
});

// ---------------------------------------------------------------------------
// GET /admin/monitor/audit-logs?search=&actor=&area=&result=&days=&page=
// ---------------------------------------------------------------------------
const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const auditLogs = catchAsync(async (req, res) => {
  const days = clampDays(req.query.days, 30);
  const { limit, skip, page: p } = page(req.query, 30, 100);
  const filter = { createdAt: { $gte: new Date(Date.now() - days * DAY_MS) } };
  if (mongoose.isValidObjectId(req.query.actor)) filter.actor = req.query.actor;
  if (req.query.area) filter.area = String(req.query.area);
  if (req.query.result === 'failed') filter.success = false;
  if (req.query.result === 'success') filter.success = true;
  if (req.query.targetId) filter.targetId = String(req.query.targetId);
  if (req.query.search) {
    const rx = new RegExp(escape(String(req.query.search).slice(0, 80)), 'i');
    filter.$or = [{ message: rx }, { path: rx }, { actorName: rx }, { actorEmail: rx }, { targetId: rx }];
  }
  const [items, total, actors, areas] = await Promise.all([
    AdminAuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AdminAuditLog.countDocuments(filter),
    safe(() => AdminAuditLog.aggregate([{ $group: { _id: '$actor', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 50 }]), []),
    safe(() => AdminAuditLog.distinct('area'), []),
  ]);
  const User = M('User');
  const actorDocs = User ? await safe(() => User.find({ _id: { $in: actors.map((a) => a._id).filter(Boolean) } }).select('name email').lean(), []) : [];
  const since = await AdminAuditLog.findOne().sort({ createdAt: 1 }).select('createdAt').lean();
  return new ApiResponse(
    200,
    {
      items,
      total,
      page: p,
      pages: Math.ceil(total / limit),
      actors: actorDocs.map((u) => ({ _id: u._id, name: u.name, email: u.email, count: actors.find((a) => String(a._id) === String(u._id))?.n || 0 })),
      areas: areas.filter(Boolean).sort(),
      trackingSince: since?.createdAt || null,
    },
    'Audit log fetched'
  ).send(res);
});

// ---------------------------------------------------------------------------
// GET /admin/monitor/auth-events?result=&search=&days=&page=
// ---------------------------------------------------------------------------
const authEvents = catchAsync(async (req, res) => {
  const days = clampDays(req.query.days, 7);
  const { limit, skip, page: p } = page(req.query, 30, 100);
  const filter = { createdAt: { $gte: new Date(Date.now() - days * DAY_MS) } };
  if (req.query.result === 'failed') filter.success = false;
  if (req.query.result === 'success') filter.success = true;
  if (req.query.client) filter.client = String(req.query.client);
  if (mongoose.isValidObjectId(req.query.user)) filter.user = req.query.user;
  if (req.query.search) {
    const rx = new RegExp(escape(String(req.query.search).slice(0, 80)), 'i');
    filter.$or = [{ email: rx }, { name: rx }, { ip: rx }];
  }
  const [items, total, failed, succeeded, since] = await Promise.all([
    AuthEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuthEvent.countDocuments(filter),
    AuthEvent.countDocuments({ ...filter, success: false }),
    AuthEvent.countDocuments({ ...filter, success: true }),
    AuthEvent.findOne().sort({ createdAt: 1 }).select('createdAt').lean(),
  ]);
  return new ApiResponse(200, { items, total, page: p, pages: Math.ceil(total / limit), summary: { failed, succeeded }, trackingSince: since?.createdAt || null }, 'Login activity fetched').send(res);
});

// ---------------------------------------------------------------------------
// GET /admin/monitor/system — API health, traffic and grouped errors
// PATCH /admin/monitor/issues/:id/resolve
// ---------------------------------------------------------------------------
const system = catchAsync(async (req, res) => {
  const days = clampDays(req.query.days, 7);
  const since = new Date(Date.now() - days * DAY_MS);
  const [traffic, issues, firstTraffic] = await Promise.all([
    ApiTraffic.find({ hour: { $gte: since } }).sort({ hour: 1 }).lean(),
    ApiIssue.find(req.query.all === 'true' ? {} : { resolvedAt: null }).sort({ lastSeenAt: -1 }).limit(200).lean(),
    ApiTraffic.findOne().sort({ hour: 1 }).select('hour').lean(),
  ]);

  // Hourly rows → per-day points (IST).
  const byDay = new Map(emptyDays(new Date(), days).map((d) => [d, { date: d, total: 0, s4xx: 0, s5xx: 0, totalMs: 0 }]));
  traffic.forEach((r) => {
    const d = byDay.get(dayKey(r.hour));
    if (!d) return;
    d.total += r.total;
    d.s4xx += r.s4xx;
    d.s5xx += r.s5xx;
    d.totalMs += r.totalMs;
  });
  const points = [...byDay.values()].map((d) => ({ date: d.date, requests: d.total, clientErrors: d.s4xx, serverErrors: d.s5xx, avgMs: d.total ? Math.round(d.totalMs / d.total) : 0 }));
  const totals = points.reduce((a, d) => ({ requests: a.requests + d.requests, serverErrors: a.serverErrors + d.serverErrors, clientErrors: a.clientErrors + d.clientErrors }), { requests: 0, serverErrors: 0, clientErrors: 0 });
  const totalMs = traffic.reduce((a, r) => a + r.totalMs, 0);

  const db = mongoose.connection;
  const mem = process.memoryUsage();
  return new ApiResponse(
    200,
    {
      days,
      server: {
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
        memoryMb: Math.round(mem.rss / 1024 / 1024),
        heapMb: Math.round(mem.heapUsed / 1024 / 1024),
        database: ['disconnected', 'connected', 'connecting', 'disconnecting'][db.readyState] || 'unknown',
        environment: process.env.NODE_ENV || 'development',
      },
      totals: { ...totals, errorRate: totals.requests ? totals.serverErrors / totals.requests : null, avgMs: totals.requests ? Math.round(totalMs / totals.requests) : null },
      traffic: points,
      issues,
      trackingSince: firstTraffic?.hour || null,
    },
    'System health fetched'
  ).send(res);
});

const resolveIssue = catchAsync(async (req, res) => {
  const issue = await ApiIssue.findByIdAndUpdate(req.params.id, { resolvedAt: new Date() }, { new: true });
  return new ApiResponse(200, issue, issue ? 'Marked as resolved' : 'Issue not found').send(res);
});

// ---------------------------------------------------------------------------
// GET /admin/monitor/search?q= — one search box for the whole panel
// ---------------------------------------------------------------------------
const search = catchAsync(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) return new ApiResponse(200, { users: [], campaigns: [], communities: [], stores: [], transactions: [] }, 'Search').send(res);
  const rx = new RegExp(escape(q), 'i');
  const isId = mongoose.isValidObjectId(q);
  const User = M('User');
  const Campaign = M('Campaign');
  const Community = M('Community');
  const Store = M('Store');
  const Transaction = M('Transaction');
  const [users, campaigns, communities, stores, transactions] = await Promise.all([
    User ? safe(() => User.find(isId ? { _id: q } : { $or: [{ name: rx }, { email: rx }, { phone: rx }] }).select('name email role avatarUrl isSuspended').limit(6).lean(), []) : [],
    Campaign ? safe(() => Campaign.find(isId ? { _id: q } : { title: rx }).select('title status approvalStatus budget').limit(5).lean(), []) : [],
    Community ? safe(() => Community.find(isId ? { _id: q } : { name: rx }).select('name slug').limit(5).lean(), []) : [],
    Store ? safe(() => Store.find(isId ? { _id: q } : { $or: [{ name: rx }, { slug: rx }] }).select('name slug status').limit(5).lean(), []) : [],
    Transaction && isId ? safe(() => Transaction.find({ _id: q }).select('type status amount createdAt').limit(1).lean(), []) : [],
  ]);
  return new ApiResponse(200, { users, campaigns, communities, stores, transactions }, 'Search').send(res);
});

// GET /admin/monitor/attention — just the "needs action" counts (cheap, polled by the top bar).
const attention = catchAsync(async (req, res) => new ApiResponse(200, await attentionList(), 'Attention fetched').send(res));

module.exports = { attention, overview, activity, auditLogs, authEvents, system, resolveIssue, search };