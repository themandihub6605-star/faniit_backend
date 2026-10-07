const { Community, CommunityMembership, CreatorProfile, User } = require('../models');
const CommunitySettings = require('../models/CommunitySettings.model');
const subscriptionService = require('./subscription.service');
const { alertUser } = require('./alert.service');
const ApiError = require('../utils/apiError');

// Paid communities: plans, the subscription gate for creating one,
// checkout through the Fanitt Store order flow (Razorpay / wallet), giving
// and taking back access, and the expiry / renewal-reminder sweep.

const PLAN_KEYS = ['monthly', 'yearly', 'lifetime'];
const PLAN_LABEL = { monthly: 'Monthly', yearly: 'Yearly', lifetime: 'One-time (lifetime)' };
const MIN_PRICE = 1000; // ₹10
const MAX_PRICE = 10000000; // ₹1,00,000
const REMIND_BEFORE_MS = 3 * 24 * 3600 * 1000;

const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN')}`;

// ---------- settings & gate ----------

async function getSettings() {
  return CommunitySettings.get();
}

/** Has a paid Fanitt plan (monthly/yearly) right now? */
async function subscriptionOf(user) {
  const appliesTo = user.role === 'brand' ? 'brand' : 'creator';
  try {
    const sub = await subscriptionService.getOrCreateActiveSubscription(user._id, appliesTo);
    const plan = sub?.plan || {};
    const active = sub?.status === 'active' && (plan.price || 0) > 0 && (!sub.currentPeriodEnd || new Date(sub.currentPeriodEnd) > new Date());
    return { hasSubscription: active, planName: plan.name || '' };
  } catch {
    return { hasSubscription: false, planName: '' };
  }
}

/** Throws when the admin requires a plan to create communities and the user has none. */
async function assertCanCreate(user) {
  if (user.role === 'admin') return;
  const settings = await getSettings();
  if (!settings.requireSubscription) return;
  const sub = await subscriptionOf(user);
  if (!sub.hasSubscription) {
    throw new ApiError(403, 'Choose a Fanitt plan (monthly or yearly) to create a community', [], 'SUBSCRIPTION_REQUIRED');
  }
}

// ---------- pricing ----------

function parseMaybeJson(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Reads { isPaid, plans: { monthly: { enabled, price }, … } } from a request
 * body (JSON or multipart text). Returns null when the body doesn't touch
 * pricing. Prices are paise.
 */
function readPricing(body) {
  if (body.isPaid === undefined && body.plans === undefined) return null;
  const isPaid = body.isPaid === true || body.isPaid === 'true';
  const raw = parseMaybeJson(body.plans) || {};
  const plans = {};
  for (const key of PLAN_KEYS) {
    const p = raw[key] || {};
    const enabled = p.enabled === true || p.enabled === 'true';
    const price = Math.round(Number(p.price) || 0);
    if (isPaid && enabled && (price < MIN_PRICE || price > MAX_PRICE)) {
      throw ApiError.badRequest(`${PLAN_LABEL[key]} price must be between ${rupees(MIN_PRICE)} and ${rupees(MAX_PRICE)}`);
    }
    plans[key] = { enabled, price: enabled ? price : 0 };
  }
  if (isPaid && !PLAN_KEYS.some((k) => plans[k].enabled)) {
    throw ApiError.badRequest('Turn on at least one plan (monthly, yearly or one-time)');
  }
  return { isPaid, plans };
}

/** Only creators can run paid communities (earnings go to their wallet). */
async function assertCanSell(user) {
  const settings = await getSettings();
  if (!settings.paidCommunitiesEnabled) throw ApiError.badRequest('Paid communities are turned off right now');
  if (user.role === 'admin') return;
  const creator = await CreatorProfile.exists({ user: user._id });
  if (!creator) throw ApiError.forbidden('Only creators can make a paid community', [], 'CREATOR_ONLY');
}

/** Applies pricing to a community document (owner only, checked by caller). */
async function applyPricing(community, pricing, user) {
  if (!pricing) return;
  if (pricing.isPaid) await assertCanSell(user);
  const wasPaid = community.isPaid;
  community.isPaid = pricing.isPaid;
  community.plans = pricing.plans;
  // Turning paid on: everyone already inside keeps free access.
  if (pricing.isPaid && !wasPaid) community.paidSince = new Date();
}

function publicPlans(community) {
  if (!community.isPaid) return [];
  return PLAN_KEYS.filter((k) => community.plans?.[k]?.enabled).map((k) => ({ key: k, label: PLAN_LABEL[k], price: community.plans[k].price }));
}

// ---------- access ----------

/** Paid period ran out? (free access and lifetime never expire) */
function isExpired(membership, now = new Date()) {
  return Boolean(
    membership &&
      membership.status === 'active' &&
      membership.access === 'paid' &&
      membership.plan !== 'lifetime' &&
      membership.paidUntil &&
      membership.paidUntil < now
  );
}

/** Flips one membership to `expired` and fixes the member count. */
async function expireMembership(membership) {
  const res = await CommunityMembership.updateOne({ _id: membership._id, status: 'active' }, { $set: { status: 'expired' } });
  if (res.modifiedCount) {
    await Community.updateOne({ _id: membership.community, memberCount: { $gt: 0 } }, { $inc: { memberCount: -1 } });
    membership.status = 'expired';
    return true;
  }
  return false;
}

function addPeriod(from, plan) {
  const d = new Date(from);
  if (plan === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (plan === 'yearly') d.setFullYear(d.getFullYear() + 1);
  return d;
}

// ---------- checkout ----------

/** Starts paying for a plan. Returns what orderService.startCheckout returns. */
async function startCheckout(buyer, community, { plan, payWith }) {
  // Lazy — the store module loads after the core models.
  const orderService = require('../FanittStore/services/order.service');
  const { ORDER_ITEM } = require('../FanittStore/constants');

  if (!community.isPaid) throw ApiError.badRequest('This community is free — just join it');
  if (!PLAN_KEYS.includes(plan) || !community.plans?.[plan]?.enabled) throw ApiError.badRequest('This plan is not available');
  if (String(community.createdBy) === String(buyer._id)) throw ApiError.badRequest('You own this community');

  const membership = await CommunityMembership.findOne({ community: community._id, user: buyer._id });
  if (membership?.status === 'banned') throw ApiError.forbidden('You have been removed from this community');
  if (membership?.status === 'active') {
    if (membership.role !== 'member') throw ApiError.badRequest('You already have full access as a moderator');
    if (membership.access === 'free') throw ApiError.badRequest('You already have free access to this community');
    if (membership.plan === 'lifetime') throw ApiError.conflict('You already have lifetime access');
  }

  const owner = await User.findById(community.createdBy).select('name isActive isSuspended');
  if (!owner || owner.isActive === false || owner.isSuspended) throw ApiError.badRequest('This community is not taking new members right now');

  const price = community.plans[plan].price;
  return orderService.startCheckout(
    buyer,
    {
      store: null,
      seller: community.createdBy,
      sellerName: community.name,
      itemType: ORDER_ITEM.COMMUNITY,
      itemId: community._id,
      itemTitle: `${community.name} · ${PLAN_LABEL[plan]}`,
      itemCoverUrl: community.iconUrl || community.coverImageUrl || '',
      amount: price,
      context: plan,
      description: `${community.name} — ${PLAN_LABEL[plan]} membership`,
      // Never reuse: two plans can cost the same, and the plan rides on the order.
      reusePending: false,
    },
    { payWith }
  );
}

/** Called once an order is paid: gives / extends access. */
async function grantFromOrder(order) {
  const plan = PLAN_KEYS.includes(order.context) ? order.context : 'monthly';
  const community = await Community.findById(order.itemId);
  if (!community) return null;

  let membership = await CommunityMembership.findOne({ community: community._id, user: order.buyer });
  const now = new Date();
  const wasActive = membership?.status === 'active';
  const wasPending = membership?.status === 'pending';

  // Renewing early adds to the time left.
  const base = wasActive && membership.access === 'paid' && membership.paidUntil && membership.paidUntil > now ? membership.paidUntil : now;
  const paidUntil = plan === 'lifetime' ? null : addPeriod(base, plan);

  if (!membership) membership = new CommunityMembership({ community: community._id, user: order.buyer });
  membership.status = 'active';
  membership.access = 'paid';
  membership.plan = plan;
  membership.paidUntil = paidUntil;
  membership.lastOrder = order._id;
  membership.renewReminderAt = null;
  await membership.save();

  const inc = { 'paidStats.revenue': order.amount, 'paidStats.payments': 1 };
  if (!wasActive) inc.memberCount = 1;
  if (wasPending) inc.pendingRequestCount = -1;
  await Community.updateOne({ _id: community._id }, { $inc: inc });

  const until = paidUntil ? ` till ${paidUntil.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ' for life';
  await Promise.all([
    alertUser({
      userId: order.buyer,
      type: 'community_join_approved',
      title: wasActive ? `Renewed — ${community.name}` : `Welcome to ${community.name} 🎉`,
      message: `Your ${PLAN_LABEL[plan].toLowerCase()} membership is active${until}.`,
      relatedModel: 'Community',
      relatedId: community._id,
      email: { tone: 'success', ctaUrl: `https://fanitt.com/open/community/${community.slug}`, ctaLabel: 'Open community' },
    }),
    alertUser({
      userId: community.createdBy,
      fromUser: order.buyer,
      type: 'store_sale',
      title: `New paid member — ${rupees(order.amount)}`,
      message: `Someone joined ${community.name} (${PLAN_LABEL[plan]}).`,
      relatedModel: 'Community',
      relatedId: community._id,
    }),
  ]);
  return membership;
}

/** Called after a refund: takes the access back if this order gave it. */
async function revokeFromOrder(order) {
  await Community.updateOne({ _id: order.itemId }, { $inc: { 'paidStats.revenue': -order.amount, 'paidStats.payments': -1 } });
  const membership = await CommunityMembership.findOne({ community: order.itemId, user: order.buyer });
  if (!membership || membership.status !== 'active' || membership.access !== 'paid') return;
  const plan = order.context;
  // Take back exactly the time this payment bought; earlier time stays.
  if ((plan === 'monthly' || plan === 'yearly') && membership.paidUntil) {
    const back = new Date(membership.paidUntil);
    if (plan === 'monthly') back.setMonth(back.getMonth() - 1);
    else back.setFullYear(back.getFullYear() - 1);
    membership.paidUntil = back;
    if (membership.plan === 'lifetime') membership.plan = plan;
  } else {
    membership.paidUntil = new Date();
    membership.plan = 'monthly';
  }
  await membership.save();
  if (!membership.paidUntil || membership.paidUntil <= new Date()) await expireMembership(membership);
}

// ---------- sweep (expiry + reminders) ----------

let lastSweep = 0;

/** Expires finished paid memberships and reminds members 3 days before. Throttled to every 15 min. */
async function runSweep({ force = false } = {}) {
  if (!force && Date.now() - lastSweep < 15 * 60 * 1000) return;
  lastSweep = Date.now();
  const now = new Date();

  const ended = await CommunityMembership.find({ status: 'active', access: 'paid', plan: { $ne: 'lifetime' }, paidUntil: { $ne: null, $lt: now } }).limit(500);
  for (const m of ended) {
    // eslint-disable-next-line no-await-in-loop
    if (await expireMembership(m)) {
      // eslint-disable-next-line no-await-in-loop
      const community = await Community.findById(m.community).select('name slug');
      if (community) {
        // eslint-disable-next-line no-await-in-loop
        await alertUser({
          userId: m.user,
          type: 'general',
          title: `Your ${community.name} membership ended`,
          message: 'Renew to get back in — your posts and chats are waiting.',
          relatedModel: 'Community',
          relatedId: community._id,
          email: { ctaUrl: `https://fanitt.com/open/community/${community.slug}`, ctaLabel: 'Renew now' },
        });
      }
    }
  }

  const soon = await CommunityMembership.find({
    status: 'active',
    access: 'paid',
    plan: { $ne: 'lifetime' },
    paidUntil: { $gt: now, $lt: new Date(now.getTime() + REMIND_BEFORE_MS) },
    renewReminderAt: null,
  }).limit(500);
  for (const m of soon) {
    // eslint-disable-next-line no-await-in-loop
    await CommunityMembership.updateOne({ _id: m._id }, { $set: { renewReminderAt: now } });
    // eslint-disable-next-line no-await-in-loop
    const community = await Community.findById(m.community).select('name slug');
    if (!community) continue;
    // eslint-disable-next-line no-await-in-loop
    await alertUser({
      userId: m.user,
      type: 'general',
      title: `${community.name} membership ends soon`,
      message: `It ends on ${m.paidUntil.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}. Renew to keep your access.`,
      relatedModel: 'Community',
      relatedId: community._id,
      email: { ctaUrl: `https://fanitt.com/open/community/${community.slug}`, ctaLabel: 'Renew now' },
    });
  }
}

module.exports = {
  PLAN_KEYS,
  PLAN_LABEL,
  MIN_PRICE,
  MAX_PRICE,
  getSettings,
  subscriptionOf,
  assertCanCreate,
  assertCanSell,
  readPricing,
  applyPricing,
  publicPlans,
  isExpired,
  expireMembership,
  startCheckout,
  grantFromOrder,
  revokeFromOrder,
  runSweep,
};