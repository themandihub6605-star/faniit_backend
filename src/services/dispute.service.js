const { Campaign, Milestone, Dispute, Transaction, CreatorProfile, BrandProfile } = require('../models');
const { TRANSACTION_TYPE, TRANSACTION_STATUS, MILESTONE_STATUS, DISPUTE_STATUS, DISPUTE_OUTCOME } = require('../constants/enums');
const walletService = require('./wallet.service');
const notificationService = require('./notification.service');
const { checkAndCompleteCampaign } = require('./milestone.service');
const ApiError = require('../utils/apiError');

/**
 * Admin resolves an open dispute (9 in the flow — Dispute Resolution
 * Process). Four possible outcomes:
 *  - full_to_creator: the disputed milestone's full amount is released to
 *    the creator, exactly like a normal approval.
 *  - refund_to_brand: the full amount is refunded to the brand — the
 *    creator gets nothing for this milestone.
 *  - partial: `creatorAmount` (must be 0..milestone.amount) goes to the
 *    creator, the remainder refunds to the brand. Two Transaction rows
 *    are created so both sides of the split are independently auditable.
 *  - revision_required: no money moves — the milestone goes back to
 *    'funded' so the creator can redo the work and resubmit (the escrow
 *    stays exactly where it was).
 *
 * Refunds are recorded in our ledger (Transaction, status REFUNDED) but
 * the actual bank-side refund via razorpay.payments.refund(paymentId) is
 * the integration point here, same pattern as escrow.service.js's
 * refundEscrow — this scaffold doesn't have RazorpayX refund credentials
 * wired up yet.
 */
async function resolveDispute({ disputeId, adminUserId, outcome, creatorAmount, adminNotes }) {
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw ApiError.notFound('Dispute not found');
  if (dispute.status !== DISPUTE_STATUS.OPEN) throw ApiError.conflict('This dispute has already been resolved');

  const milestone = await Milestone.findById(dispute.milestone);
  if (!milestone) throw ApiError.notFound('Milestone not found');

  const campaign = await Campaign.findById(dispute.campaign).populate('brand');
  const brandProfile = campaign.brand;

  let resolvedCreatorAmount = null;
  let resolvedBrandRefundAmount = null;

  if (outcome === DISPUTE_OUTCOME.REVISION_REQUIRED) {
    // No money moves — creator redoes the work on the same funded milestone.
    milestone.status = MILESTONE_STATUS.FUNDED;
    milestone.autoReleaseAt = null;
    await milestone.save();
  } else {
    let payoutToCreator = 0;
    let refundToBrand = 0;

    if (outcome === DISPUTE_OUTCOME.FULL_TO_CREATOR) {
      payoutToCreator = milestone.amount;
    } else if (outcome === DISPUTE_OUTCOME.REFUND_TO_BRAND) {
      refundToBrand = milestone.amount;
    } else if (outcome === DISPUTE_OUTCOME.PARTIAL) {
      if (creatorAmount == null || creatorAmount < 0 || creatorAmount > milestone.amount) {
        throw ApiError.badRequest('creatorAmount must be between 0 and the milestone amount for a partial resolution.');
      }
      payoutToCreator = creatorAmount;
      refundToBrand = milestone.amount - creatorAmount;
    } else {
      throw ApiError.badRequest('Unrecognized dispute outcome.');
    }

    if (payoutToCreator > 0) {
      const { platformCommission, agencyCommission, referralCommission, netAmount } = await walletService.splitEarnings(
        payoutToCreator,
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
        amount: payoutToCreator,
        platformCommission,
        agencyCommission,
        referralCommission,
        netAmount,
        relatedModel: 'Milestone',
        relatedId: milestone._id,
        escrowReleasedAt: new Date(),
        escrowReleasedBy: adminUserId,
        notes: `Dispute resolution (${outcome})`,
      });

      await walletService.creditCreator(milestone.creator, netAmount);
      milestone.payoutTransaction = payoutTransaction._id;

      await notificationService.notify({
        userId: creator.user._id,
        type: 'payout_released',
        title: 'Dispute resolved — payment released',
        message: `₹${(netAmount / 100).toLocaleString('en-IN')} has been released for "${milestone.title}" following dispute resolution.`,
        relatedModel: 'Campaign',
        relatedId: campaign._id,
      });
    }

    if (refundToBrand > 0) {
      await Transaction.create({
        type: TRANSACTION_TYPE.REFUND,
        status: TRANSACTION_STATUS.REFUNDED,
        from: null,
        to: brandProfile.user,
        amount: refundToBrand,
        relatedModel: 'Milestone',
        relatedId: milestone._id,
        escrowReleasedAt: new Date(),
        escrowReleasedBy: adminUserId,
        notes: `Dispute resolution refund (${outcome})`,
      });

      await notificationService.notify({
        userId: brandProfile.user,
        type: 'dispute_refund',
        title: 'Dispute resolved — refund issued',
        message: `₹${(refundToBrand / 100).toLocaleString('en-IN')} has been refunded for "${milestone.title}" following dispute resolution.`,
        relatedModel: 'Campaign',
        relatedId: campaign._id,
      });
    }

    resolvedCreatorAmount = payoutToCreator;
    resolvedBrandRefundAmount = refundToBrand;

    milestone.status = MILESTONE_STATUS.RELEASED;
    milestone.releasedAt = new Date();
    milestone.autoReleaseAt = null;
    await milestone.save();

    await checkAndCompleteCampaign(campaign);
  }

  dispute.status = DISPUTE_STATUS.RESOLVED;
  dispute.resolution = {
    outcome,
    creatorAmount: resolvedCreatorAmount,
    brandRefundAmount: resolvedBrandRefundAmount,
    adminNotes: adminNotes || '',
    resolvedBy: adminUserId,
    resolvedAt: new Date(),
  };
  await dispute.save();

  return dispute;
}

async function getOpenDisputes() {
  return Dispute.find({ status: DISPUTE_STATUS.OPEN })
    .populate({ path: 'campaign', select: 'title budget brand', populate: { path: 'brand', select: 'companyName' } })
    .populate({ path: 'milestone', select: 'title amount submissionDescription submissionLinks submissionAttachments' })
    .populate('raisedBy', 'name email')
    .sort({ createdAt: -1 });
}

async function getDisputeById(disputeId) {
  const dispute = await Dispute.findById(disputeId)
    .populate({ path: 'campaign', populate: { path: 'brand', select: 'companyName user' } })
    .populate('milestone')
    .populate('raisedBy', 'name email');
  if (!dispute) throw ApiError.notFound('Dispute not found');
  return dispute;
}

module.exports = { resolveDispute, getOpenDisputes, getDisputeById };