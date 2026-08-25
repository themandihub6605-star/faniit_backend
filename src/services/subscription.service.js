const razorpay = require('../config/razorpay');
const { User, SubscriptionPlan, UserSubscription, Transaction } = require('../models');
const { debitUser } = require('./wallet.service');
const ApiError = require('../utils/apiError');
const { BILLING_CYCLE, SUBSCRIPTION_STATUS, TRANSACTION_TYPE, TRANSACTION_STATUS, SUBSCRIPTION_APPLIES_TO } = require('../constants/enums');

function addCycle(date, billingCycle) {
  const d = new Date(date);
  if (billingCycle === BILLING_CYCLE.YEARLY) d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

/** Creates (or updates) the matching Razorpay Plan object for a paid
 * SubscriptionPlan, so an admin editing price/cycle in the DB stays in
 * sync with what Razorpay will actually bill. Free plans (price 0) never
 * need a Razorpay plan — there's nothing to charge. */
async function ensureRazorpayPlan(plan) {
  if (plan.price <= 0) return plan;

  if (!plan.razorpayPlanId) {
    const rzpPlan = await razorpay.plans.create({
      period: plan.billingCycle === BILLING_CYCLE.YEARLY ? 'yearly' : 'monthly',
      interval: 1,
      item: {
        name: `Fanitt ${plan.name} (${plan.appliesTo})`,
        amount: plan.price,
        currency: 'INR',
      },
    });
    plan.razorpayPlanId = rzpPlan.id;
    await plan.save();
  }
  // Razorpay plans are immutable once created — if price/cycle changes,
  // the admin controller creates a fresh Razorpay plan and swaps the id
  // (see admin controller's plan update handler).
  return plan;
}

async function getDefaultPlan(appliesTo) {
  const plan = await SubscriptionPlan.findOne({ appliesTo, isDefault: true, isActive: true });
  if (!plan) throw ApiError.internal(`No default ${appliesTo} plan is configured — contact an admin`);
  return plan;
}

/** Returns the user's current subscription, creating one on the role's
 * default (free) plan if none exists yet, and rolling over an expired
 * period — resetting usage counters and, for a lapsed paid plan with no
 * confirmed renewal, downgrading back to the free default. */
async function getOrCreateActiveSubscription(userId, appliesTo) {
  let sub = await UserSubscription.findOne({ user: userId }).populate('plan');

  if (!sub) {
    const defaultPlan = await getDefaultPlan(appliesTo);
    sub = await UserSubscription.create({
      user: userId,
      plan: defaultPlan._id,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      currentPeriodStart: new Date(),
      currentPeriodEnd: addCycle(new Date(), defaultPlan.billingCycle),
    });
    sub = await sub.populate('plan');
    return sub;
  }

  if (sub.currentPeriodEnd && new Date() > sub.currentPeriodEnd) {
    const isPaidPlanStillActive = sub.plan.price > 0 && sub.status === SUBSCRIPTION_STATUS.ACTIVE && sub.razorpaySubscriptionId && !sub.cancelAtPeriodEnd;

    if (isPaidPlanStillActive) {
      // Renewal should have arrived via the subscription.charged webhook
      // already; if we're here it just hasn't landed yet — roll the
      // window forward optimistically rather than block the user.
      sub.currentPeriodStart = sub.currentPeriodEnd;
      sub.currentPeriodEnd = addCycle(sub.currentPeriodEnd, sub.plan.billingCycle);
    } else {
      // Free plan cycle rollover, or a paid plan that lapsed/was
      // cancelled — reset onto the role's default plan.
      const defaultPlan = await getDefaultPlan(appliesTo);
      sub.plan = defaultPlan._id;
      sub.status = SUBSCRIPTION_STATUS.ACTIVE;
      sub.razorpaySubscriptionId = '';
      sub.cancelAtPeriodEnd = false;
      sub.currentPeriodStart = new Date();
      sub.currentPeriodEnd = addCycle(new Date(), defaultPlan.billingCycle);
    }
    sub.proposalsUsedThisCycle = 0;
    sub.campaignsPostedThisCycle = 0;
    await sub.save();
    sub = await sub.populate('plan');
  }

  return sub;
}

/** Records one proposal against the creator's plan quota. If the quota is
 * exhausted, auto-charges the plan's per-extra-proposal fee from their
 * wallet — throws if their balance can't cover it (the proposal is not
 * sent in that case). */
async function consumeCreatorProposal(userId) {
  const sub = await getOrCreateActiveSubscription(userId, SUBSCRIPTION_APPLIES_TO.CREATOR);
  const plan = sub.plan;

  const withinLimit = plan.proposalLimit == null || sub.proposalsUsedThisCycle < plan.proposalLimit;

  if (!withinLimit) {
    const user = await User.findById(userId);
    if (user.walletBalance < plan.extraProposalCost) {
      throw ApiError.badRequest(
        `You've used all ${plan.proposalLimit} proposals for this cycle. Extra proposals cost ₹${(plan.extraProposalCost / 100).toFixed(2)} — please add money to your wallet.`
      );
    }
    await debitUser(userId, plan.extraProposalCost);
    await Transaction.create({
      type: TRANSACTION_TYPE.EXTRA_PROPOSAL_FEE,
      from: userId,
      amount: plan.extraProposalCost,
      status: TRANSACTION_STATUS.SUCCESS,
      notes: 'Extra proposal fee (over plan quota)',
    });
  }

  sub.proposalsUsedThisCycle += 1;
  await sub.save();
}

/** Records one campaign post against the brand's plan quota — throws if
 * the quota is exhausted (no auto-pay path for campaigns; the brand must
 * upgrade). Call this at publish time, not draft-creation time. */
async function consumeBrandCampaignSlot(userId) {
  const sub = await getOrCreateActiveSubscription(userId, SUBSCRIPTION_APPLIES_TO.BRAND);
  const plan = sub.plan;

  const withinLimit = plan.campaignPostLimit == null || sub.campaignsPostedThisCycle < plan.campaignPostLimit;
  if (!withinLimit) {
    throw ApiError.badRequest(
      `You've reached your ${plan.name} plan's limit of ${plan.campaignPostLimit} campaign(s) for this ${plan.billingCycle === 'yearly' ? 'year' : 'month'}. Upgrade to post more.`
    );
  }

  sub.campaignsPostedThisCycle += 1;
  await sub.save();
  return sub;
}

async function getCreatorPlanFields(userId) {
  const sub = await getOrCreateActiveSubscription(userId, SUBSCRIPTION_APPLIES_TO.CREATOR);
  return sub.plan;
}

async function getBrandPlanFields(userId) {
  const sub = await getOrCreateActiveSubscription(userId, SUBSCRIPTION_APPLIES_TO.BRAND);
  return sub.plan;
}

module.exports = {
  ensureRazorpayPlan,
  getOrCreateActiveSubscription,
  consumeCreatorProposal,
  consumeBrandCampaignSlot,
  getCreatorPlanFields,
  getBrandPlanFields,
  addCycle,
};