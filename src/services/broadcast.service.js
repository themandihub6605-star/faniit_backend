const mongoose = require('mongoose');
const {
  Broadcast,
  Notification,
  User,
  SubscriptionPlan,
  UserSubscription,
  CreatorProfile,
  BrandProfile,
  AgencyProfile,
} = require('../models');
const { getFirebaseAdmin } = require('../config/firebase');

const INSERT_BATCH = 1000;
const PUSH_BATCH = 500; // FCM multicast limit
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

const DAY = 24 * 60 * 60 * 1000;
const ALL_ROLES = ['fan', 'creator', 'brand', 'agency'];
const PLAN_ROLES = ['creator', 'brand']; // only these have subscription plans
const PROFILE_ROLES = { creator: CreatorProfile, brand: BrandProfile, agency: AgencyProfile };

const pick = (value, allowed, fallback = 'any') => (allowed.includes(value) ? value : fallback);
const days = (value) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : null;
};

/** Cleans whatever the admin panel sent into a safe filters object. */
function normalizeFilters(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const planIds = Array.isArray(f.planIds)
    ? [...new Set(f.planIds.map(String).filter((id) => mongoose.isValidObjectId(id)))]
    : [];
  let plan = pick(f.plan, Broadcast.PLAN_FILTERS);
  if (plan === 'plans' && !planIds.length) plan = 'any';
  return {
    plan,
    planIds: plan === 'plans' ? planIds : [],
    verification: pick(f.verification, Broadcast.VERIFICATION_FILTERS),
    onboarded: pick(f.onboarded, Broadcast.YES_NO),
    emailVerified: pick(f.emailVerified, Broadcast.YES_NO),
    loginWithinDays: days(f.loginWithinDays),
    inactiveDays: days(f.inactiveDays),
    joinedWithinDays: days(f.joinedWithinDays),
    appOnly: f.appOnly === true || f.appOnly === 'true',
  };
}

/** Users on a paid plan right now (inside the paid period, or auto-renewing). */
async function paidUserIds(now, extra = {}) {
  const paidPlans = await SubscriptionPlan.find({ price: { $gt: 0 } }).distinct('_id');
  if (!paidPlans.length) return [];
  return UserSubscription.find({
    plan: { $in: extra.planIds ? paidPlans.filter((id) => extra.planIds.includes(String(id))) : paidPlans },
    status: { $ne: 'expired' },
    $or: [
      { currentPeriodEnd: { $gt: now } },
      { status: 'active', razorpaySubscriptionId: { $nin: ['', null] }, cancelAtPeriodEnd: { $ne: true } },
    ],
  }).distinct('user');
}

/**
 * Mongo filter for a broadcast's audience: roles + optional filters
 * (plan, verification, signup, email, login activity, join date, app).
 * Built from id lists (no $lookup) so it works on FerretDB too.
 */
async function audienceFilter(broadcast) {
  if (broadcast.testEmail) return { email: broadcast.testEmail };
  const f = normalizeFilters(broadcast.filters);
  const now = new Date();
  const and = [{ isActive: { $ne: false } }, { isSuspended: { $ne: true } }];

  let roles = broadcast.roles && broadcast.roles.length ? [...broadcast.roles] : [...ALL_ROLES];
  let roleLimited = !!(broadcast.roles && broadcast.roles.length);

  // --- Subscription plan (creators & brands only) ---
  if (f.plan !== 'any') {
    roles = roles.filter((r) => PLAN_ROLES.includes(r));
    roleLimited = true;
    if (f.plan === 'paid') {
      and.push({ _id: { $in: await paidUserIds(now) } });
    } else if (f.plan === 'free') {
      and.push({ _id: { $nin: await paidUserIds(now) } });
    } else if (f.plan === 'expiring') {
      const paid = await paidUserIds(now);
      const ending = await UserSubscription.find({
        user: { $in: paid },
        currentPeriodEnd: { $gt: now, $lte: new Date(now.getTime() + 7 * DAY) },
        $or: [{ cancelAtPeriodEnd: true }, { razorpaySubscriptionId: { $in: ['', null] } }],
      }).distinct('user');
      and.push({ _id: { $in: ending } });
    } else if (f.plan === 'plans') {
      const plans = await SubscriptionPlan.find({ _id: { $in: f.planIds } }).select('price appliesTo');
      roles = roles.filter((r) => plans.some((p) => p.appliesTo === r));
      const paidSelected = plans.filter((p) => p.price > 0).map((p) => String(p._id));
      const freeRoles = [...new Set(plans.filter((p) => p.price <= 0).map((p) => p.appliesTo))].filter((r) => roles.includes(r));
      const or = [];
      if (paidSelected.length) or.push({ _id: { $in: await paidUserIds(now, { planIds: paidSelected }) } });
      // A free plan = everyone of that role who isn't paying right now.
      if (freeRoles.length) or.push({ role: { $in: freeRoles }, _id: { $nin: await paidUserIds(now) } });
      and.push(or.length ? { $or: or } : { _id: { $in: [] } });
    }
  }

  // --- Profile verification (creators, brands, agencies) ---
  if (f.verification !== 'any') {
    roles = roles.filter((r) => PROFILE_ROLES[r]);
    roleLimited = true;
    const ids = [];
    for (const r of roles) {
      // eslint-disable-next-line no-await-in-loop
      ids.push(...(await PROFILE_ROLES[r].find({ verificationStatus: f.verification }).distinct('user')));
    }
    and.push({ _id: { $in: ids } });
  }

  // --- Account state & activity ---
  if (f.onboarded === 'yes') and.push({ onboardingCompleted: true });
  if (f.onboarded === 'no') and.push({ onboardingCompleted: { $ne: true } });
  if (f.emailVerified === 'yes') and.push({ isEmailVerified: true });
  if (f.emailVerified === 'no') and.push({ isEmailVerified: { $ne: true } });
  if (f.loginWithinDays) and.push({ lastLoginAt: { $gte: new Date(now.getTime() - f.loginWithinDays * DAY) } });
  if (f.inactiveDays) {
    const cutoff = new Date(now.getTime() - f.inactiveDays * DAY);
    // Never logged in counts as inactive only if the account itself is older than the cutoff.
    and.push({ $or: [{ lastLoginAt: { $lt: cutoff } }, { lastLoginAt: null, createdAt: { $lt: cutoff } }] });
  }
  if (f.joinedWithinDays) and.push({ createdAt: { $gte: new Date(now.getTime() - f.joinedWithinDays * DAY) } });
  if (f.appOnly) and.push({ 'pushTokens.token': { $exists: true } });

  and.unshift(roleLimited ? { role: { $in: roles } } : { role: { $ne: 'admin' } });
  return { $and: and };
}

/** How many accounts a broadcast would reach, in total and per role (admin preview). */
async function countAudience({ roles = [], testEmail = '', filters = {} }) {
  const filter = await audienceFilter({ roles, testEmail, filters });
  const count = await User.countDocuments(filter);
  if (testEmail) return { count, byRole: {} };
  const byRole = {};
  await Promise.all(
    ALL_ROLES.map(async (r) => {
      byRole[r] = count ? await User.countDocuments({ $and: [filter, { role: r }] }) : 0;
    })
  );
  return { count, byRole };
}

function pushPayload(broadcast, tokens) {
  const data = {
    type: 'general',
    broadcastId: String(broadcast._id),
    ...(broadcast.link ? { link: broadcast.link } : {}),
    ...(broadcast.imageUrl ? { imageUrl: broadcast.imageUrl } : {}),
  };
  const image = broadcast.imageUrl || undefined;
  return {
    tokens,
    notification: { title: broadcast.title, body: broadcast.message, ...(image ? { imageUrl: image } : {}) },
    data,
    android: {
      priority: 'high',
      notification: { channelId: 'fanitt_default', color: '#F4511E', ...(image ? { imageUrl: image } : {}) },
    },
    apns: {
      payload: { aps: { sound: 'default', 'mutable-content': 1 } },
      ...(image ? { fcmOptions: { imageUrl: image } } : {}),
    },
  };
}

/**
 * Delivers a broadcast: one in-app notification per user plus a push to
 * every registered device. Updates the broadcast's stats and status.
 */
async function deliver(broadcast) {
  const stats = { targeted: 0, inApp: 0, devices: 0, pushSent: 0, pushFailed: 0 };
  try {
    const users = await User.find(await audienceFilter(broadcast)).select('_id +pushTokens');
    stats.targeted = users.length;

    // In-app notifications (website + app notification lists)
    for (let i = 0; i < users.length; i += INSERT_BATCH) {
      const docs = users.slice(i, i + INSERT_BATCH).map((u) => ({
        user: u._id,
        type: 'general',
        title: broadcast.title,
        message: broadcast.message,
        imageUrl: broadcast.imageUrl || '',
        link: broadcast.link || '',
        relatedModel: 'Broadcast',
        relatedId: broadcast._id,
      }));
      // eslint-disable-next-line no-await-in-loop
      await Notification.insertMany(docs, { ordered: false });
      stats.inApp += docs.length;
    }

    // Push to phones
    const tokens = [];
    const ownerOf = new Map();
    for (const u of users) {
      for (const t of u.pushTokens || []) {
        if (t?.token && !ownerOf.has(t.token)) {
          tokens.push(t.token);
          ownerOf.set(t.token, u._id);
        }
      }
    }
    stats.devices = tokens.length;

    if (tokens.length) {
      let admin = null;
      try {
        admin = getFirebaseAdmin();
      } catch (err) {
        console.error('[broadcast] Firebase not configured:', err.message);
      }
      if (admin) {
        const dead = [];
        for (let i = 0; i < tokens.length; i += PUSH_BATCH) {
          const batch = tokens.slice(i, i + PUSH_BATCH);
          try {
            // eslint-disable-next-line no-await-in-loop
            const res = await admin.messaging().sendEachForMulticast(pushPayload(broadcast, batch));
            stats.pushSent += res.successCount;
            stats.pushFailed += res.failureCount;
            res.responses.forEach((r, idx) => {
              if (!r.success && DEAD_TOKEN_CODES.has(r.error?.code)) dead.push(batch[idx]);
            });
          } catch (err) {
            stats.pushFailed += batch.length;
            console.error('[broadcast] push batch failed:', err.message);
          }
        }
        if (dead.length) {
          await User.updateMany({ 'pushTokens.token': { $in: dead } }, { $pull: { pushTokens: { token: { $in: dead } } } });
        }
      }
    }

    broadcast.status = 'sent';
    broadcast.sentAt = new Date();
    broadcast.error = '';
  } catch (err) {
    console.error('[broadcast] delivery failed:', err);
    broadcast.status = 'failed';
    broadcast.error = err.message;
  }
  broadcast.stats = stats;
  await broadcast.save();
  return broadcast;
}

/** Runs every due scheduled broadcast. Each one is claimed atomically so
 * two server processes never send the same broadcast twice. */
async function runDueBroadcasts() {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const due = await Broadcast.findOneAndUpdate(
      { status: 'scheduled', scheduledAt: { $lte: new Date() } },
      { status: 'sending' },
      { sort: { scheduledAt: 1 }, new: true }
    );
    if (!due) return;
    // eslint-disable-next-line no-await-in-loop
    await deliver(due);
  }
}

/** Broadcasts left in 'sending' by a crash/restart go back to the queue. */
async function recoverStuck() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  await Broadcast.updateMany({ status: 'sending', updatedAt: { $lt: cutoff } }, { status: 'scheduled' });
}

let timer = null;
function startScheduler(intervalMs = 30 * 1000) {
  if (timer) return;
  const tick = () => runDueBroadcasts().catch((err) => console.error('[broadcast] scheduler failed:', err.message));
  recoverStuck().catch(() => {});
  setTimeout(tick, 10 * 1000);
  timer = setInterval(tick, intervalMs);
}

module.exports = { deliver, runDueBroadcasts, startScheduler, countAudience, normalizeFilters };