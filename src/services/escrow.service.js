const { Campaign, Transaction, CreatorProfile } = require('../models');
const { TRANSACTION_TYPE, TRANSACTION_STATUS, CAMPAIGN_STATUS } = require('../constants/enums');
const walletService = require('./wallet.service');
const notificationService = require('./notification.service');
const ApiError = require('../utils/apiError');

/**
 * Called once a brand's Razorpay payment for a campaign budget is verified.
 * Marks the funds as "in escrow" — held by the platform, not yet the
 * creator's — until the brand approves the submitted work.
 */
async function fundEscrow({ campaignId, brandUserId, amount, razorpayOrderId, razorpayPaymentId }) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw ApiError.notFound('Campaign not found');

  const transaction = await Transaction.create({
    type: TRANSACTION_TYPE.CAMPAIGN_ESCROW_DEPOSIT,
    status: TRANSACTION_STATUS.IN_ESCROW,
    from: brandUserId,
    to: null,
    amount,
    relatedModel: 'Campaign',
    relatedId: campaign._id,
    razorpayOrderId,
    razorpayPaymentId,
  });

  campaign.escrowTransaction = transaction._id;
  campaign.isEscrowFunded = true;
  campaign.status = CAMPAIGN_STATUS.IN_PROGRESS;
  await campaign.save();

  return transaction;
}

/**
 * Called when the brand approves the creator's submitted work. Releases the
 * escrowed funds to the creator (minus platform/agency commission), moving
 * the transaction from IN_ESCROW -> RELEASED.
 */
async function releaseEscrow({ campaignId, releasedByUserId = null }) {
  const campaign = await Campaign.findById(campaignId).populate('escrowTransaction');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.isEscrowFunded) throw ApiError.badRequest('Campaign has no funded escrow to release');
  if (campaign.isEscrowReleased) throw ApiError.badRequest('Escrow has already been released');
  if (!campaign.assignedCreator) throw ApiError.badRequest('Campaign has no assigned creator');

  const { platformCommission, agencyCommission, netAmount } = await walletService.splitEarnings(
    campaign.budget,
    campaign.assignedCreator
  );

  const creator = await CreatorProfile.findById(campaign.assignedCreator).populate('user');

  const payoutTransaction = await Transaction.create({
    type: TRANSACTION_TYPE.CAMPAIGN_PAYOUT,
    status: TRANSACTION_STATUS.RELEASED,
    from: null,
    to: creator.user._id,
    amount: campaign.budget,
    platformCommission,
    agencyCommission,
    netAmount,
    relatedModel: 'Campaign',
    relatedId: campaign._id,
    escrowReleasedAt: new Date(),
    escrowReleasedBy: releasedByUserId,
  });

  await walletService.creditCreator(campaign.assignedCreator, netAmount);

  campaign.isEscrowReleased = true;
  campaign.status = CAMPAIGN_STATUS.COMPLETED;
  campaign.approvedAt = new Date();
  await campaign.save();

  await notificationService.notify({
    userId: creator.user._id,
    type: 'payout_released',
    title: 'Payment released',
    message: `₹${(netAmount / 100).toLocaleString('en-IN')} has been released for "${campaign.title}".`,
    relatedModel: 'Campaign',
    relatedId: campaign._id,
  });

  return payoutTransaction;
}

/**
 * Refunds escrowed funds back to the brand — used when a campaign is
 * cancelled or a dispute is resolved in the brand's favor (admin-triggered).
 */
async function refundEscrow({ campaignId, refundedByUserId = null }) {
  const campaign = await Campaign.findById(campaignId).populate('escrowTransaction');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.isEscrowFunded || campaign.isEscrowReleased) {
    throw ApiError.badRequest('No active escrow to refund');
  }

  campaign.escrowTransaction.status = TRANSACTION_STATUS.REFUNDED;
  campaign.escrowTransaction.escrowReleasedAt = new Date();
  campaign.escrowTransaction.escrowReleasedBy = refundedByUserId;
  await campaign.escrowTransaction.save();

  campaign.status = CAMPAIGN_STATUS.CANCELLED;
  await campaign.save();

  // NOTE: actual bank refund via razorpay.payments.refund(paymentId) is the
  // integration point here once RazorpayX/refund credentials are live.
  return campaign.escrowTransaction;
}

module.exports = { fundEscrow, releaseEscrow, refundEscrow };
