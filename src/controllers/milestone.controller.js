const { Campaign, Milestone } = require('../models');
const paymentService = require('../services/payment.service');
const milestoneService = require('../services/milestone.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

// GET /campaigns/:id/milestones — either the brand that owns the campaign
// or the creator assigned to it can view its milestones.
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

// Shared by submitMilestone below and requestChanges/raiseDispute in their
// own controllers — turns whatever multer put on req.files into the
// { name, url } shape the Milestone schema's attachment fields expect.
function filesToAttachments(files) {
  return (files || []).map((f) => ({ name: f.originalname, url: f.path }));
}

// PATCH /milestones/:id/submit — creator submits (or resubmits) work for a
// funded / changes-requested milestone. Accepts multipart form data:
// description, links (JSON array string), and up to 5 files.
const submitMilestone = catchAsync(async (req, res) => {
  const { description } = req.body;
  let links = [];
  try {
    links = req.body.links ? JSON.parse(req.body.links) : [];
  } catch {
    throw ApiError.badRequest('links must be a JSON array of URLs');
  }

  const milestone = await milestoneService.submitMilestoneWork({
    milestoneId: req.params.id,
    creatorUserId: req.user._id,
    description,
    links: (links || []).filter(Boolean),
    attachments: filesToAttachments(req.files),
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

// PATCH /milestones/:id/request-changes — brand asks for a revision instead
// of approving. Accepts multipart: changeDescription, referenceLinks (JSON
// array string), up to 5 files.
const requestMilestoneChanges = catchAsync(async (req, res) => {
  const { changeDescription } = req.body;
  if (!changeDescription?.trim()) throw ApiError.badRequest('Please describe what needs to change');

  let referenceLinks = [];
  try {
    referenceLinks = req.body.referenceLinks ? JSON.parse(req.body.referenceLinks) : [];
  } catch {
    throw ApiError.badRequest('referenceLinks must be a JSON array of URLs');
  }

  const milestone = await milestoneService.requestChanges({
    milestoneId: req.params.id,
    brandUserId: req.user._id,
    changeDescription: changeDescription.trim(),
    referenceLinks: (referenceLinks || []).filter(Boolean),
    attachments: filesToAttachments(req.files),
  });

  return new ApiResponse(200, milestone, 'Change request sent to creator').send(res);
});

// POST /milestones/:id/dispute — brand raises a dispute instead of
// approving/requesting changes. Accepts multipart: reason, up to 5 evidence files.
const raiseMilestoneDispute = catchAsync(async (req, res) => {
  const { reason } = req.body;
  if (!reason?.trim()) throw ApiError.badRequest('Please describe the reason for this dispute');

  const dispute = await milestoneService.raiseDispute({
    milestoneId: req.params.id,
    brandUserId: req.user._id,
    reason: reason.trim(),
    attachments: filesToAttachments(req.files),
  });

  return new ApiResponse(201, dispute, 'Dispute raised — the Fanitt team will review it').send(res);
});

module.exports = {
  getMilestonesForCampaign,
  initiateMilestoneFunding,
  verifyMilestonePayment,
  submitMilestone,
  approveMilestone,
  requestMilestoneChanges,
  raiseMilestoneDispute,
};