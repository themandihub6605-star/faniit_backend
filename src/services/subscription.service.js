const razorpay = require('../config/razorpay');
const { User, SubscriptionPlan, UserSubscription, Transaction } = require('../models');
const ApiError = require('../utils/apiError');
const {
  BILLING_CYCLE,
  SUBSCRIPTION_STATUS,
  TRANSACTION_TYPE,
  TRANSACTION_STATUS,
  SUBSCRIPTION_APPLIES_TO,
  CREATOR_CAMPAIGN_ACCESS,
  CAMPAIGN_VISIBILITY_TIER,
} = require('../constants/enums');

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
      sub.currentPeriodStart = sub.currentPeriodEnd;
      sub.currentPeriodEnd = addCycle(sub.currentPeriodEnd, sub.plan.billingCycle);
    } else {
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

/** Read-only check: does this creator have proposal quota left, or if
 * not, can the extra-proposal fee be auto-charged from their wallet?
 * Throws — without mutating anything — if they're blocked either way.
 *
 * Deliberately does NOT consume the quota or charge the wallet here.
 * Call finalizeCreatorProposal() only after the Application document has
 * actually been created, so a failure in between (validation error, DB
 * hiccup) never leaves a charged wallet or a consumed quota slot with no
 * proposal to show for it. */
async function checkCreatorProposalQuota(userId) {
  const sub = await getOrCreateActiveSubscription(userId, SUBSCRIPTION_APPLIES_TO.CREATOR);
  const plan = sub.plan;

  const withinLimit = plan.proposalLimit == null || sub.proposalsUsedThisCycle < plan.proposalLimit;

  if (!withinLimit) {
    const user = await User.findById(userId);
    if (user.walletBalance < plan.extraProposalCost) {
      throw ApiError.badRequest(
        `You've used all ${plan.proposalLimit} proposals for this cycle. Extra proposals cost ₹${(plan.extraProposalCost / 100).toFixed(2)} — please add money to your wallet.`,
        [],
        'PROPOSAL_QUOTA_EXCEEDED'
      );
    }
    return { plan, needsExtraCharge: true };
  }

  return { plan, needsExtraCharge: false };
}

/** Call ONLY after the Application has been successfully created (and any
 * campaign.applicantCount bump saved). Charges the extra-proposal fee if
 * needed, then increments the usage counter. If this throws, the caller
 * must roll back the Application/applicantCount it just created — the
 * quota was never consumed, so nothing else needs undoing here. */
async function finalizeCreatorProposal(userId, needsExtraCharge) {
  const sub = await UserSubscription.findOne({ user: userId }).populate('plan');
  const plan = sub.plan;

  if (needsExtraCharge) {
    // Lazy require: wallet.service.js requires this file back (for
    // getCreatorPlanFields), so a top-level require here would create a
    // circular-dependency load order issue — requiring it inside the
    // function body sidesteps that.
    const { debitUser } = require('./wallet.service');
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

/** Read-only check: does this brand have a campaign-post slot left this
 * cycle? Throws — without mutating anything — if not (no auto-pay path
 * for campaigns, the brand must upgrade). Returns the loaded
 * subscription doc so the caller can pass it straight to
 * finalizeBrandCampaignUsage() without a second DB round trip. */
async function checkBrandCampaignQuota(userId) {
  const sub = await getOrCreateActiveSubscription(userId, SUBSCRIPTION_APPLIES_TO.BRAND);
  const plan = sub.plan;

  const withinLimit = plan.campaignPostLimit == null || sub.campaignsPostedThisCycle < plan.campaignPostLimit;
  if (!withinLimit) {
    throw ApiError.badRequest(
      `You've reached your ${plan.name} plan's limit of ${plan.campaignPostLimit} campaign(s) for this ${plan.billingCycle === 'yearly' ? 'year' : 'month'}. Upgrade to post more.`,
      [],
      'CAMPAIGN_QUOTA_EXCEEDED'
    );
  }

  return { sub, plan };
}

/** Call ONLY after the campaign has been saved with status OPEN and the
 * brand's totalCampaigns bumped. Kept separate from the check above so a
 * publish that fails partway through never consumes a slot the brand
 * didn't actually get to use. */
async function finalizeBrandCampaignUsage(sub) {
  sub.campaignsPostedThisCycle += 1;
  await sub.save();
}

/** User ids (not profile ids — the `user` field both CreatorProfile and
 * BrandProfile store) currently on a "sees everyone" tier: Pro/Exclusive
 * for creators (campaignAccessTier: 'all'), Pro/Elite for brands
 * (campaignVisibilityTier: 'exclusive'). Used to build a $nin filter for
 * Lite-tier viewers — see isViewerOnLiteTier below and its callers in
 * creator.controller.js / brand.controller.js.
 *
 * Deliberately computed as an exclusion set rather than an inclusion
 * set: a profile with NO UserSubscription row yet (never triggered
 * getOrCreateActiveSubscription) is implicitly on the free default —
 * i.e. Lite — plan, exactly like one with an explicit Lite row. Trying
 * to build the Lite-tier id list directly would miss those profiles;
 * excluding the Pro-tier ids handles both cases correctly with one
 * query, no need to enumerate every Lite subscriber. */
async function getProTierUserIds(appliesTo) {
  const isCreator = appliesTo === SUBSCRIPTION_APPLIES_TO.CREATOR;
  const tierField = isCreator ? 'campaignAccessTier' : 'campaignVisibilityTier';
  const proTierValue = isCreator ? CREATOR_CAMPAIGN_ACCESS.ALL : CAMPAIGN_VISIBILITY_TIER.EXCLUSIVE;

  const proPlanIds = await SubscriptionPlan.find({ appliesTo, [tierField]: proTierValue }).distinct('_id');
  return UserSubscription.find({ plan: { $in: proPlanIds } }).distinct('user');
}

/** Is this user (a creator or a brand — appliesTo says which) currently
 * on the Lite/free tier for cross-visibility purposes? True for the
 * free default plan AND for anyone with no subscription row yet (same
 * "implicitly Lite" reasoning as getProTierUserIds above). Used to
 * decide whether a listing needs the Lite-only visibility filter at
 * all — a Pro/Exclusive viewer sees everyone, so no filter is applied
 * for them. */
async function isViewerOnLiteTier(userId, appliesTo) {
  const plan = await (appliesTo === SUBSCRIPTION_APPLIES_TO.CREATOR ? getCreatorPlanFields(userId) : getBrandPlanFields(userId));
  return appliesTo === SUBSCRIPTION_APPLIES_TO.CREATOR
    ? plan.campaignAccessTier !== CREATOR_CAMPAIGN_ACCESS.ALL
    : plan.campaignVisibilityTier !== CAMPAIGN_VISIBILITY_TIER.EXCLUSIVE;
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
  getProTierUserIds,
  isViewerOnLiteTier,
  getOrCreateActiveSubscription,
  checkCreatorProposalQuota,
  finalizeCreatorProposal,
  checkBrandCampaignQuota,
  finalizeBrandCampaignUsage,
  getCreatorPlanFields,
  getBrandPlanFields,
  addCycle,
};