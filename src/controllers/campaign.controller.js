const { Campaign, Application, BrandProfile, CreatorProfile, User } = require('../models');
const paymentService = require('../services/payment.service');
const escrowService = require('../services/escrow.service');
const notificationService = require('../services/notification.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { ROLES, CAMPAIGN_STATUS, APPLICATION_STATUS } = require('../constants/enums');

const listCampaigns = catchAsync(async (req, res) => {
  const { category, status = CAMPAIGN_STATUS.OPEN, page = 1, limit = 20 } = req.query;

  const filter = {};
  if (category) filter.category = category;
  if (status) filter.status = status;

  const campaigns = await Campaign.find(filter)
    .populate({ path: 'brand', populate: { path: 'user', select: 'name avatarUrl' } })
    .populate('category', 'label icon')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit));

  const total = await Campaign.countDocuments(filter);

  return new ApiResponse(200, { campaigns, total, page: Number(page), pages: Math.ceil(total / limit) }, 'Campaigns fetched').send(res);
});

const getCampaignById = catchAsync(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id)
    .populate({ path: 'brand', populate: { path: 'user', select: 'name avatarUrl' } })
    .populate('category', 'label icon')
    .populate({ path: 'assignedCreator', populate: { path: 'user', select: 'name avatarUrl' } });

  if (!campaign) throw ApiError.notFound('Campaign not found');
  return new ApiResponse(200, campaign, 'Campaign fetched').send(res);
});

const createCampaign = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.BRAND) throw ApiError.forbidden('Only brands can post a requirement');

  const brand = await BrandProfile.findOne({ user: req.user._id });
  if (!brand) throw ApiError.notFound('Brand profile not found');

  const campaign = await Campaign.create({ ...req.body, brand: brand._id });

  brand.totalCampaigns += 1;
  await brand.save();

  return new ApiResponse(201, campaign, 'Requirement posted').send(res);
});

const applyToCampaign = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.CREATOR) throw ApiError.forbidden('Only creators can apply to campaigns');

  const { pitch, quotedAmount, deliverables } = req.body;

  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (campaign.status !== CAMPAIGN_STATUS.OPEN) throw ApiError.badRequest('This campaign is no longer accepting applications');

  const creator = await CreatorProfile.findOne({ user: req.user._id });
  const existing = await Application.findOne({ campaign: campaign._id, creator: creator._id });
  if (existing) throw ApiError.conflict('You have already applied to this campaign');

  const application = await Application.create({
    campaign: campaign._id,
    creator: creator._id,
    pitch,
    quotedAmount: quotedAmount ?? null,
    deliverables: deliverables || [],
  });

  campaign.applicantCount += 1;
  await campaign.save();

  await notificationService.notify({
    userId: campaign.brand,
    type: 'proposal_received',
    title: 'New proposal received',
    message: `A creator sent a proposal for "${campaign.title}".`,
    relatedModel: 'Campaign',
    relatedId: campaign._id,
  });

  return new ApiResponse(201, application, 'Proposal sent').send(res);
});

const getMyProposals = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.CREATOR) throw ApiError.forbidden('Only creators have proposals');

  const creator = await CreatorProfile.findOne({ user: req.user._id });
  if (!creator) throw ApiError.notFound('Creator profile not found');

  const { status } = req.query;

  const filter = { creator: creator._id };
  if (status) filter.status = status;

  const proposals = await Application.find(filter)
    .populate({ path: 'campaign', populate: { path: 'brand', populate: { path: 'user', select: 'name avatarUrl' } } })
    .sort({ createdAt: -1 });

  const counts = {
    all: await Application.countDocuments({ creator: creator._id }),
    pending: await Application.countDocuments({ creator: creator._id, status: APPLICATION_STATUS.PENDING }),
    accepted: await Application.countDocuments({ creator: creator._id, status: APPLICATION_STATUS.ACCEPTED }),
    rejected: await Application.countDocuments({ creator: creator._id, status: APPLICATION_STATUS.REJECTED }),
  };

  return new ApiResponse(200, { proposals, counts }, 'Proposals fetched').send(res);
});

const getApplications = catchAsync(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).populate('brand');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');

  const applications = await Application.find({ campaign: campaign._id })
    .populate({ path: 'creator', populate: { path: 'user', select: 'name avatarUrl' } })
    .sort({ createdAt: -1 });

  return new ApiResponse(200, applications, 'Applications fetched').send(res);
});

const decideApplication = catchAsync(async (req, res) => {
  const { decision, feedback } = req.body;
  const campaign = await Campaign.findById(req.params.id).populate('brand');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');

  const application = await Application.findById(req.params.appId);
  if (!application) throw ApiError.notFound('Application not found');

  application.status = decision === 'accepted' ? APPLICATION_STATUS.ACCEPTED : APPLICATION_STATUS.REJECTED;
  application.respondedAt = new Date();
  if (feedback) application.feedback = feedback;
  await application.save();

  if (decision === 'accepted') {
    campaign.assignedCreator = application.creator;
    await campaign.save();
  }

  await notificationService.notify({
    userId: (await CreatorProfile.findById(application.creator)).user,
    type: 'proposal_status_update',
    title: decision === 'accepted' ? 'Proposal accepted!' : 'Proposal declined',
    message:
      decision === 'accepted'
        ? `You've been accepted for "${campaign.title}". Waiting for the brand to fund escrow.`
        : `Your proposal for "${campaign.title}" was declined.`,
    relatedModel: 'Campaign',
    relatedId: campaign._id,
  });

  return new ApiResponse(200, application, `Proposal ${decision}`).send(res);
});

const toggleSaveCampaign = catchAsync(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) throw ApiError.notFound('Campaign not found');

  const user = await User.findById(req.user._id);
  const alreadySaved = user.savedCampaigns.some((id) => id.equals(campaign._id));

  if (alreadySaved) {
    user.savedCampaigns.pull(campaign._id);
  } else {
    user.savedCampaigns.push(campaign._id);
  }
  await user.save();

  return new ApiResponse(200, { saved: !alreadySaved }, alreadySaved ? 'Removed from saved' : 'Saved').send(res);
});

const getSavedCampaigns = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).populate({
    path: 'savedCampaigns',
    populate: [{ path: 'brand', populate: { path: 'user', select: 'name avatarUrl' } }, { path: 'category', select: 'label icon' }],
  });

  return new ApiResponse(200, user.savedCampaigns, 'Saved opportunities fetched').send(res);
});

const initiateEscrowFunding = catchAsync(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).populate('brand');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');
  if (!campaign.assignedCreator) throw ApiError.badRequest('Accept a creator before funding escrow');
  if (campaign.isEscrowFunded) throw ApiError.conflict('Escrow has already been funded');

  const order = await paymentService.createOrder(campaign.budget, `campaign_${campaign._id}`, {
    campaignId: String(campaign._id),
  });

  return new ApiResponse(200, { order }, 'Complete payment to fund escrow').send(res);
});

const verifyEscrowPayment = catchAsync(async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
  const campaign = await Campaign.findById(req.params.id).populate('brand');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');

  const isValid = paymentService.verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature });
  if (!isValid) throw ApiError.badRequest('Payment verification failed');

  await escrowService.fundEscrow({
    campaignId: campaign._id,
    brandUserId: req.user._id,
    amount: campaign.budget,
    razorpayOrderId,
    razorpayPaymentId,
  });

  campaign.brand.totalSpent += campaign.budget;
  await campaign.brand.save();

  return new ApiResponse(200, null, 'Escrow funded — creator can now begin work').send(res);
});

const submitWork = catchAsync(async (req, res) => {
  const { workUrl } = req.body;
  const campaign = await Campaign.findById(req.params.id).populate('assignedCreator');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.assignedCreator.user.equals(req.user._id)) throw ApiError.forbidden('You are not assigned to this campaign');
  if (!campaign.isEscrowFunded) throw ApiError.badRequest('Escrow has not been funded yet');

  campaign.submittedWorkUrl = workUrl;
  campaign.submittedAt = new Date();
  campaign.status = CAMPAIGN_STATUS.SUBMITTED;
  await campaign.save();

  await notificationService.notify({
    userId: (await BrandProfile.findById(campaign.brand)).user,
    type: 'campaign_update',
    title: 'Work submitted',
    message: `Work has been submitted for "${campaign.title}". Review and approve to release payment.`,
    relatedModel: 'Campaign',
    relatedId: campaign._id,
  });

  return new ApiResponse(200, campaign, 'Work submitted').send(res);
});

const approveWork = catchAsync(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).populate('brand');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');
  if (campaign.status !== CAMPAIGN_STATUS.SUBMITTED) throw ApiError.badRequest('No submitted work to approve');

  await escrowService.releaseEscrow({ campaignId: campaign._id, releasedByUserId: req.user._id });

  return new ApiResponse(200, null, 'Work approved — payment released to creator').send(res);
});

module.exports = {
  listCampaigns,
  getCampaignById,
  createCampaign,
  applyToCampaign,
  getMyProposals,
  getApplications,
  decideApplication,
  toggleSaveCampaign,
  getSavedCampaigns,
  initiateEscrowFunding,
  verifyEscrowPayment,
  submitWork,
  approveWork,
};