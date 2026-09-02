const { Campaign, Milestone } = require('../models');
const paymentService = require('../services/payment.service');
const milestoneService = require('../services/milestone.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

// GET /campaigns/:campaignId/milestones — either the brand that owns the
// campaign or the creator assigned to it can view its milestones.
const getMilestonesForCampaign = catchAsync(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).populate('brand').populate('assignedCreator');
  if (!campaign) throw ApiError.notFound('Campaign not found');

  const isBrandOwner = campaign.brand.user.equals(req.user._id);
  const isAssignedCreator = campaign.assignedCreator && campaign.assignedCreator.user.equals(req.user._id);
  if (!isBrandOwner && !isAssignedCreator) {
    throw ApiError.forbidden('You do not have access to this campaign');
  }

  const milestones = await Milestone.find({ campaign: campaign._id }).sort({ order: 1 });
  return new ApiResponse(200, milestones, 'Milestones fetched').send(res);
});

// POST /milestones/:id/fund — brand starts the Razorpay checkout for one milestone.
const initiateMilestoneFunding = catchAsync(async (req, res) => {
  const milestone = await Milestone.findById(req.params.id).populate('campaign');
  if (!milestone) throw ApiError.notFound('Milestone not found');

  const campaign = await Campaign.findById(milestone.campaign._id).populate('brand');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');
  if (milestone.status !== 'pending') throw ApiError.conflict('This milestone has already been funded');

  const order = await paymentService.createOrder(milestone.amount, `milestone_${milestone._id}`, {
    milestoneId: String(milestone._id),
    campaignId: String(campaign._id),
  });

  return new ApiResponse(200, { order }, 'Complete payment to fund this milestone').send(res);
});

// POST /milestones/:id/verify-payment — brand's Razorpay payment confirmed client-side.
const verifyMilestonePayment = catchAsync(async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
  const milestone = await Milestone.findById(req.params.id).populate('campaign');
  if (!milestone) throw ApiError.notFound('Milestone not found');

  const campaign = await Campaign.findById(milestone.campaign._id).populate('brand');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');

  const isValid = paymentService.verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature });
  if (!isValid) throw ApiError.badRequest('Payment verification failed');

  const { milestone: fundedMilestone } = await milestoneService.fundMilestone({
    milestoneId: milestone._id,
    brandUserId: req.user._id,
    razorpayOrderId,
    razorpayPaymentId,
  });

  return new ApiResponse(200, fundedMilestone, 'Milestone funded — creator can now begin work').send(res);
});

// PATCH /milestones/:id/submit — creator submits work for a funded milestone.
const submitMilestone = catchAsync(async (req, res) => {
  const { workUrl } = req.body;
  if (!workUrl || !workUrl.trim()) throw ApiError.badRequest('A link to your deliverable is required');

  const milestone = await milestoneService.submitMilestoneWork({
    milestoneId: req.params.id,
    creatorUserId: req.user._id,
    workUrl: workUrl.trim(),
  });

  return new ApiResponse(200, milestone, 'Work submitted').send(res);
});

// PATCH /milestones/:id/approve — brand approves, releasing this milestone's funds.
const approveMilestone = catchAsync(async (req, res) => {
  const milestone = await Milestone.findById(req.params.id).populate('campaign');
  if (!milestone) throw ApiError.notFound('Milestone not found');

  const campaign = await Campaign.findById(milestone.campaign._id).populate('brand');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');

  await milestoneService.releaseMilestone({ milestoneId: milestone._id, releasedByUserId: req.user._id });

  return new ApiResponse(200, null, 'Milestone approved — payment released to creator').send(res);
});

module.exports = {
  getMilestonesForCampaign,
  initiateMilestoneFunding,
  verifyMilestonePayment,
  submitMilestone,
  approveMilestone,
};