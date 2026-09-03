const { Campaign, Milestone, Dispute, Transaction, CreatorProfile, BrandProfile, User, SiteSettings } = require('../models');
const {
  TRANSACTION_TYPE,
  TRANSACTION_STATUS,
  CAMPAIGN_STATUS,
  MILESTONE_STATUS,
  DISPUTE_STATUS,
  DISPUTE_OUTCOME,
  ROLES,
} = require('../constants/enums');
const walletService = require('./wallet.service');
const notificationService = require('./notification.service');
const { creditReferralCommission } = require('./referral.service');
const ApiError = require('../utils/apiError');

/**
 * Called once, the moment a brand accepts a creator's application (see
 * campaign.controller.js decideApplication). Splits the campaign's whole
 * budget into Campaign.milestoneCount equal milestones (1-4, brand's
 * choice at creation time — any rounding remainder goes to the last
 * milestone so the total always exactly equals the budget). All start in
 * 'pending'; nothing is charged here.
 */
async function createInitialMilestones(campaign) {
  if (!campaign.assignedCreator) {
    throw ApiError.badRequest('Cannot create milestones before a creator is assigned');
  }

  const count = Math.min(4, Math.max(1, campaign.milestoneCount || 2));
  const perMilestone = Math.floor(campaign.budget / count);
  const remainder = campaign.budget - perMilestone * count;

  const milestonesData = Array.from({ length: count }, (_, i) => ({
    campaign: campaign._id,
    creator: campaign.assignedCreator,
    title: count === 1 ? 'Full payment' : `Milestone ${i + 1}`,
    amount: perMilestone + (i === count - 1 ? remainder : 0),
    order: i + 1,
    isAdvance: i === 0,
    status: MILESTONE_STATUS.PENDING,
  }));

  return Milestone.insertMany(milestonesData);
}

/**
 * Brand's Razorpay payment for one milestone has been verified — moves it
 * from 'pending' to 'funded'. Enforces sequential unlocking: milestone N
 * can only be funded once milestone N-1 is RELEASED, so a brand can never
 * skip ahead and fund milestone 3 while 1-2 are still outstanding.
 */
async function fundMilestone({ milestoneId, brandUserId, razorpayOrderId, razorpayPaymentId }) {
  const milestone = await Milestone.findById(milestoneId).populate('campaign');
  if (!milestone) throw ApiError.notFound('Milestone not found');
  if (milestone.status !== MILESTONE_STATUS.PENDING) {
    throw ApiError.conflict('This milestone has already been funded');
  }

  if (milestone.order > 1) {
    const previous = await Milestone.findOne({ campaign: milestone.campaign._id, order: milestone.order - 1 });
    if (!previous || previous.status !== MILESTONE_STATUS.RELEASED) {
      throw ApiError.conflict('Fund and release the previous milestone before this one unlocks.');
    }
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

  const campaign = milestone.campaign;
  if (!campaign.isEscrowFunded) {
    campaign.isEscrowFunded = true;
    campaign.status = CAMPAIGN_STATUS.IN_PROGRESS;
    await campaign.save();
  }

  await creditReferralCommission(brandUserId, milestone.amount, 'Milestone', milestone._id);

  const creator = await CreatorProfile.findById(milestone.creator);
  await notificationService.notify({
    userId: creator.user,
    type: 'milestone_funded',
    title: milestone.isAdvance ? 'Milestone funded' : 'Milestone funded',
    message: `₹${(milestone.amount / 100).toLocaleString('en-IN')} has been funded for "${milestone.title}" on "${campaign.title}". You can start work.`,
    relatedModel: 'Campaign',
    relatedId: campaign._id,
  });

  return { milestone, transaction };
}

/**
 * Creator submits (or re-submits, after a change request) work for a
 * funded milestone. Records description/links/attachments and — if
 * SiteSettings.milestoneAutoReleaseDays > 0 — the point after which the
 * auto-release sweep will release it even if the brand never reviews.
 * Clears any prior change-request fields since this submission supersedes them.
 */
async function submitMilestoneWork({ milestoneId, creatorUserId, description, links = [], attachments = [] }) {
  const milestone = await Milestone.findById(milestoneId).populate('campaign');
  if (!milestone) throw ApiError.notFound('Milestone not found');

  const creator = await CreatorProfile.findById(milestone.creator);
  if (!creator || !creator.user.equals(creatorUserId)) {
    throw ApiError.forbidden('You are not assigned to this milestone');
  }
  if (![MILESTONE_STATUS.FUNDED, MILESTONE_STATUS.CHANGES_REQUESTED].includes(milestone.status)) {
    throw ApiError.badRequest('This milestone is not awaiting a submission right now.');
  }

  const settings = await SiteSettings.getSingleton();
  const autoReleaseAt =
    settings.milestoneAutoReleaseDays > 0
      ? new Date(Date.now() + settings.milestoneAutoReleaseDays * 24 * 3600 * 1000)
      : null;

  milestone.submissionDescription = description || '';
  milestone.submissionLinks = links;
  milestone.submissionAttachments = attachments;
  milestone.submittedAt = new Date();
  milestone.autoReleaseAt = autoReleaseAt;
  milestone.status = MILESTONE_STATUS.SUBMITTED;
  // clear any prior change-request — this submission is the response to it
  milestone.changeDescription = '';
  milestone.changeReferenceLinks = [];
  milestone.changeAttachments = [];
  milestone.changesRequestedAt = null;
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
 * commission). Called by the brand approving, or by the auto-release
 * sweep when the review window elapsed. If this was the last unreleased
 * milestone on the campaign, marks the whole campaign completed.
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

  await checkAndCompleteCampaign(campaign);

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
 * Brand requests changes on submitted work (8B in the flow) — no money
 * moves, the milestone just goes back to the creator with feedback.
 * Pauses auto-release (there's nothing "awaiting review" anymore).
 */
async function requestChanges({ milestoneId, brandUserId, changeDescription, referenceLinks = [], attachments = [] }) {
  const milestone = await Milestone.findById(milestoneId).populate('campaign');
  if (!milestone) throw ApiError.notFound('Milestone not found');

  const campaign = await Campaign.findById(milestone.campaign._id).populate('brand');
  if (!campaign.brand.user.equals(brandUserId)) throw ApiError.forbidden('You do not own this campaign');
  if (milestone.status !== MILESTONE_STATUS.SUBMITTED) {
    throw ApiError.badRequest('No submitted work to request changes on.');
  }

  milestone.status = MILESTONE_STATUS.CHANGES_REQUESTED;
  milestone.changeDescription = changeDescription;
  milestone.changeReferenceLinks = referenceLinks;
  milestone.changeAttachments = attachments;
  milestone.changesRequestedAt = new Date();
  milestone.autoReleaseAt = null;
  await milestone.save();

  const creator = await CreatorProfile.findById(milestone.creator);
  await notificationService.notify({
    userId: creator.user,
    type: 'milestone_changes_requested',
    title: 'Changes requested',
    message: `${campaign.brand.companyName} requested changes on "${milestone.title}" for "${campaign.title}".`,
    relatedModel: 'Campaign',
    relatedId: campaign._id,
  });

  return milestone;
}

/**
 * Brand raises a dispute on submitted work (8C in the flow) — creates a
 * Dispute document holding their reason/evidence and moves the milestone
 * to DISPUTED, awaiting admin resolution (see dispute.service.js). No
 * money moves here; that only happens once an admin resolves it.
 */
async function raiseDispute({ milestoneId, brandUserId, reason, attachments = [] }) {
  const milestone = await Milestone.findById(milestoneId).populate('campaign');
  if (!milestone) throw ApiError.notFound('Milestone not found');

  const campaign = await Campaign.findById(milestone.campaign._id).populate('brand');
  if (!campaign.brand.user.equals(brandUserId)) throw ApiError.forbidden('You do not own this campaign');
  if (milestone.status !== MILESTONE_STATUS.SUBMITTED) {
    throw ApiError.badRequest('You can only dispute submitted work.');
  }

  const dispute = await Dispute.create({
    campaign: campaign._id,
    milestone: milestone._id,
    raisedBy: brandUserId,
    reason,
    attachments,
    status: DISPUTE_STATUS.OPEN,
  });

  milestone.status = MILESTONE_STATUS.DISPUTED;
  milestone.dispute = dispute._id;
  milestone.autoReleaseAt = null;
  await milestone.save();

  // Notify every admin — there's no single "assigned" admin for disputes
  // in this scaffold, so everyone with the admin role sees it in their
  // notifications until one of them resolves it from /admin/disputes.
  const admins = await User.find({ role: ROLES.ADMIN });
  for (const admin of admins) {
    await notificationService.notify({
      userId: admin._id,
      type: 'dispute_raised',
      title: 'New dispute raised',
      message: `${campaign.brand.companyName} raised a dispute on "${milestone.title}" for "${campaign.title}".`,
      relatedModel: 'Campaign',
      relatedId: campaign._id,
    });
  }

  return dispute;
}

/** Shared by releaseMilestone and dispute.service.js's resolveDispute:
 * marks the campaign completed once every one of its milestones is
 * RELEASED. Written to hold for any milestoneCount (1-4), not just the
 * old fixed advance+final pair. */
async function checkAndCompleteCampaign(campaign) {
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
}

/**
 * Auto-release sweep — finds every SUBMITTED milestone whose autoReleaseAt
 * has passed and releases it, as if the brand had approved. Never touches
 * CHANGES_REQUESTED or DISPUTED milestones (their autoReleaseAt is always
 * null while in those states — see requestChanges/raiseDispute above).
 * Intended to be invoked on a schedule (see scripts/autoReleaseMilestones.js).
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
  requestChanges,
  raiseDispute,
  checkAndCompleteCampaign,
  runAutoReleaseSweep,
};