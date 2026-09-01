const { Campaign, Milestone, Transaction, CreatorProfile, SiteSettings } = require('../models');
const { TRANSACTION_TYPE, TRANSACTION_STATUS, CAMPAIGN_STATUS, MILESTONE_STATUS } = require('../constants/enums');
const walletService = require('./wallet.service');
const notificationService = require('./notification.service');
const { creditReferralCommission } = require('./referral.service');
const ApiError = require('../utils/apiError');

/**
 * Called once, the moment a brand accepts a creator's application (see
 * campaign.controller.js decideApplication). Splits the campaign's whole
 * budget into two milestones — an advance (SiteSettings.
 * campaignAdvancePercent, e.g. 20%) and one final-delivery milestone for
 * the remainder — both starting in 'pending'. Nothing is charged here;
 * this only creates the records the brand will fund next.
 */
async function createInitialMilestones(campaign) {
  if (!campaign.assignedCreator) {
    throw ApiError.badRequest('Cannot create milestones before a creator is assigned');
  }

  const settings = await SiteSettings.getSingleton();
  const advancePercent = settings.campaignAdvancePercent;

  const advanceAmount = Math.round((campaign.budget * advancePercent) / 100);
  const finalAmount = campaign.budget - advanceAmount;

  const milestones = await Milestone.create([
    {
      campaign: campaign._id,
      creator: campaign.assignedCreator,
      title: `Advance (${advancePercent}%)`,
      amount: advanceAmount,
      order: 1,
      isAdvance: true,
      status: MILESTONE_STATUS.PENDING,
    },
    {
      campaign: campaign._id,
      creator: campaign.assignedCreator,
      title: 'Final delivery',
      amount: finalAmount,
      order: 2,
      isAdvance: false,
      status: MILESTONE_STATUS.PENDING,
    },
  ]);

  return milestones;
}

/**
 * Brand's Razorpay payment for one milestone has been verified — moves it
 * from 'pending' to 'funded'. Mirrors escrow.service.js's fundEscrow but
 * scoped to a single milestone's amount rather than the whole budget.
 */
async function fundMilestone({ milestoneId, brandUserId, razorpayOrderId, razorpayPaymentId }) {
  const milestone = await Milestone.findById(milestoneId).populate('campaign');
  if (!milestone) throw ApiError.notFound('Milestone not found');
  if (milestone.status !== MILESTONE_STATUS.PENDING) {
    throw ApiError.conflict('This milestone has already been funded');
  }

  const transaction = await Transaction.create({
    type: TRANSACTION_TYPE.CAMPAIGN_ESCROW_DEPOSIT,
    status: TRANSACTION_STATUS.IN_ESCROW,
    from: brandUserId,
    to: null,
    amount: milestone.amount,
    relatedModel: 'Milestone',
    relatedId: milestone._id,
    razorpayOrderId,
    razorpayPaymentId,
  });

  milestone.escrowTransaction = transaction._id;
  milestone.status = MILESTONE_STATUS.FUNDED;
  milestone.fundedAt = new Date();
  await milestone.save();

  // First milestone funded on this campaign flips it into progress —
  // subsequent milestone funding (the final one) doesn't need to touch
  // campaign status again.
  const campaign = milestone.campaign;
  if (!campaign.isEscrowFunded) {
    campaign.isEscrowFunded = true;
    campaign.status = CAMPAIGN_STATUS.IN_PROGRESS;
    await campaign.save();
  }

  // Same reasoning as the original fundEscrow: a referred brand's
  // referrer earns a cut of this spend too, regardless of which
  // milestone it came from.
  await creditReferralCommission(brandUserId, milestone.amount, 'Milestone', milestone._id);

  const creator = await CreatorProfile.findById(milestone.creator);
  await notificationService.notify({
    userId: creator.user,
    type: 'milestone_funded',
    title: milestone.isAdvance ? 'Advance funded' : 'Milestone funded',
    message: `₹${(milestone.amount / 100).toLocaleString('en-IN')} has been funded for "${milestone.title}" on "${campaign.title}". You can start work.`,
    relatedModel: 'Campaign',
    relatedId: campaign._id,
  });

  return { milestone, transaction };
}

/**
 * Creator submits work for a funded milestone. Records when it was
 * submitted and — if SiteSettings.milestoneAutoReleaseDays > 0 — the
 * point after which the auto-release sweep will release it even if the
 * brand never reviews.
 */
async function submitMilestoneWork({ milestoneId, creatorUserId, workUrl }) {
  const milestone = await Milestone.findById(milestoneId).populate('campaign');
  if (!milestone) throw ApiError.notFound('Milestone not found');

  const creator = await CreatorProfile.findById(milestone.creator);
  if (!creator || !creator.user.equals(creatorUserId)) {
    throw ApiError.forbidden('You are not assigned to this milestone');
  }
  if (milestone.status !== MILESTONE_STATUS.FUNDED) {
    throw ApiError.badRequest('This milestone is not funded yet, or has already been submitted');
  }

  const settings = await SiteSettings.getSingleton();
  const autoReleaseAt =
    settings.milestoneAutoReleaseDays > 0
      ? new Date(Date.now() + settings.milestoneAutoReleaseDays * 24 * 3600 * 1000)
      : null;

  milestone.submittedWorkUrl = workUrl;
  milestone.submittedAt = new Date();
  milestone.autoReleaseAt = autoReleaseAt;
  milestone.status = MILESTONE_STATUS.SUBMITTED;
  await milestone.save();

  const campaignWithBrand = await Campaign.findById(milestone.campaign._id).populate('brand');
  await notificationService.notify({
    userId: campaignWithBrand.brand.user,
    type: 'milestone_submitted',
    title: 'Work submitted',
    message: `Work has been submitted for "${milestone.title}" on "${milestone.campaign.title}". Review and approve to release payment.`,
    relatedModel: 'Campaign',
    relatedId: milestone.campaign._id,
  });

  return milestone;
}

/**
 * Releases one submitted milestone's escrowed funds to the creator (minus
 * commission), same split-and-credit logic as the original single-escrow
 * releaseEscrow. Called either by the brand approving (isAutoRelease:
 * false) or by the auto-release sweep (isAutoRelease: true) when the
 * review window elapsed. If this was the last unreleased milestone on the
 * campaign, marks the whole campaign completed.
 */
async function releaseMilestone({ milestoneId, releasedByUserId = null, isAutoRelease = false }) {
  const milestone = await Milestone.findById(milestoneId).populate('campaign');
  if (!milestone) throw ApiError.notFound('Milestone not found');
  if (milestone.status !== MILESTONE_STATUS.SUBMITTED) {
    throw ApiError.badRequest('No submitted work to approve for this milestone');
  }

  const campaign = milestone.campaign;

  const { platformCommission, agencyCommission, referralCommission, netAmount } = await walletService.splitEarnings(
    milestone.amount,
    milestone.creator,
    'Milestone',
    milestone._id
  );

  const creator = await CreatorProfile.findById(milestone.creator).populate('user');

  const payoutTransaction = await Transaction.create({
    type: TRANSACTION_TYPE.CAMPAIGN_PAYOUT,
    status: TRANSACTION_STATUS.RELEASED,
    from: null,
    to: creator.user._id,
    amount: milestone.amount,
    platformCommission,
    agencyCommission,
    referralCommission,
    netAmount,
    relatedModel: 'Milestone',
    relatedId: milestone._id,
    escrowReleasedAt: new Date(),
    escrowReleasedBy: releasedByUserId,
    notes: isAutoRelease ? 'Auto-released after review window elapsed' : '',
  });

  await walletService.creditCreator(milestone.creator, netAmount);

  milestone.payoutTransaction = payoutTransaction._id;
  milestone.status = MILESTONE_STATUS.RELEASED;
  milestone.releasedAt = new Date();
  milestone.autoReleaseAt = null;
  await milestone.save();

  // Whole-campaign completion: only once every milestone tied to this
  // campaign has been released — with exactly two milestones today
  // (advance + final) this fires when the final one clears, but it's
  // written to hold even if a future admin/product change adds more.
  const remaining = await Milestone.countDocuments({
    campaign: campaign._id,
    status: { $ne: MILESTONE_STATUS.RELEASED },
  });
  if (remaining === 0) {
    campaign.isEscrowReleased = true;
    campaign.status = CAMPAIGN_STATUS.COMPLETED;
    campaign.approvedAt = new Date();
    await campaign.save();
  }

  await notificationService.notify({
    userId: creator.user._id,
    type: 'payout_released',
    title: isAutoRelease ? 'Payment auto-released' : 'Payment released',
    message: `₹${(netAmount / 100).toLocaleString('en-IN')} has been released for "${milestone.title}" on "${campaign.title}".`,
    relatedModel: 'Campaign',
    relatedId: campaign._id,
  });

  return payoutTransaction;
}

/**
 * Auto-release sweep — finds every SUBMITTED milestone whose autoReleaseAt
 * has passed and releases it, as if the brand had approved. Intended to
 * be invoked on a schedule (see scripts/autoReleaseMilestones.js), not
 * from an HTTP request. Processes sequentially and keeps going on a
 * per-milestone failure so one bad record doesn't block the rest of the
 * sweep; failures are returned for the caller to log/alert on.
 */
async function runAutoReleaseSweep() {
  const due = await Milestone.find({
    status: MILESTONE_STATUS.SUBMITTED,
    autoReleaseAt: { $ne: null, $lte: new Date() },
  });

  const released = [];
  const failed = [];

  for (const milestone of due) {
    try {
      await releaseMilestone({ milestoneId: milestone._id, releasedByUserId: null, isAutoRelease: true });
      released.push(milestone._id);
    } catch (err) {
      failed.push({ milestoneId: milestone._id, error: err.message });
    }
  }

  return { released, failed };
}

module.exports = {
  createInitialMilestones,
  fundMilestone,
  submitMilestoneWork,
  releaseMilestone,
  runAutoReleaseSweep,
};