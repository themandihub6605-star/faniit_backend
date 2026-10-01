const {
  Campaign,
  Application,
  BrandProfile,
  CreatorProfile,
  User,
  Milestone,
  Transaction,
  SiteSettings,
} = require('../models');
const notificationService = require('../services/notification.service');
const subscriptionService = require('../services/subscription.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { CAMPAIGN_STATUS } = require('../constants/enums');

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * GET /api/admin/campaigns/all
 * ?approval=pending|approved|rejected  ?status=<campaign status>  ?search=  ?page=
 * Search matches the campaign title or the brand's company name / email.
 */
const listCampaigns = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const filter = {};

  const { approval, status } = req.query;
  if (approval === 'pending') filter.approvalStatus = 'pending';
  else if (approval === 'rejected') filter.approvalStatus = 'rejected';
  else if (approval === 'approved') filter.approvalStatus = { $nin: ['pending', 'rejected'] };

  if (status && Object.values(CAMPAIGN_STATUS).includes(status)) filter.status = status;
  else filter.status = { $ne: CAMPAIGN_STATUS.DRAFT };
  // Rejected campaigns go back to draft for the brand to fix — still list them.
  if (approval === 'rejected') delete filter.status;

  const search = String(req.query.search || '').trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    const users = await User.find({ $or: [{ name: pattern }, { email: pattern }] }).select('_id').limit(300);
    const brands = await BrandProfile.find({ $or: [{ companyName: pattern }, { user: { $in: users.map((u) => u._id) } }] })
      .select('_id')
      .limit(300);
    filter.$or = [{ title: pattern }, { brand: { $in: brands.map((b) => b._id) } }];
  }

  const [campaigns, total, pendingCount] = await Promise.all([
    Campaign.find(filter)
      .populate({ path: 'brand', select: 'companyName logoUrl slug user', populate: { path: 'user', select: 'name email' } })
      .populate('category', 'label')
      .populate({ path: 'assignedCreator', select: 'slug user', populate: { path: 'user', select: 'name' } })
      .sort({ submittedForReviewAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Campaign.countDocuments(filter),
    Campaign.countDocuments({ approvalStatus: 'pending' }),
  ]);

  return new ApiResponse(200, { campaigns, total, page, pages: Math.ceil(total / limit), pendingCount }, 'Campaigns fetched').send(res);
});

/**
 * GET /api/admin/campaigns/:id/details
 * Everything about one campaign: brand, every proposal with quoted amount,
 * hired creator, milestones and the money trail.
 */
const getCampaignDetails = catchAsync(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id)
    .populate({ path: 'brand', populate: { path: 'user', select: 'name email phone avatarUrl' } })
    .populate('category', 'label')
    .populate({ path: 'assignedCreator', populate: { path: 'user', select: 'name email avatarUrl' } })
    .populate('reviewedBy', 'name email');
  if (!campaign) throw ApiError.notFound('Campaign not found');

  const [applications, milestones, transactions] = await Promise.all([
    Application.find({ campaign: campaign._id })
      .populate({ path: 'creator', select: 'slug followerCount category user', populate: { path: 'user', select: 'name email avatarUrl' } })
      .sort({ createdAt: -1 }),
    Milestone.find({ campaign: campaign._id }).sort({ order: 1 }),
    Transaction.find({
      $or: [{ relatedModel: 'Campaign', relatedId: campaign._id }],
    })
      .populate('from', 'name email')
      .populate('to', 'name email')
      .sort({ createdAt: -1 }),
  ]);

  // Milestone-level transactions (escrow funding and payouts)
  const milestoneTx = milestones.length
    ? await Transaction.find({ relatedModel: 'Milestone', relatedId: { $in: milestones.map((m) => m._id) } })
        .populate('from', 'name email')
        .populate('to', 'name email')
        .sort({ createdAt: -1 })
    : [];

  const quotes = applications.map((a) => a.quotedAmount).filter((q) => q != null && q > 0);
  const summary = {
    applicants: applications.length,
    pending: applications.filter((a) => a.status === 'pending').length,
    accepted: applications.filter((a) => a.status === 'accepted').length,
    rejected: applications.filter((a) => a.status === 'rejected').length,
    lowestQuote: quotes.length ? Math.min(...quotes) : null,
    highestQuote: quotes.length ? Math.max(...quotes) : null,
    milestoneTotal: milestones.reduce((s, m) => s + (m.amount || 0), 0),
    fundedTotal: milestones.filter((m) => m.fundedAt).reduce((s, m) => s + (m.amount || 0), 0),
    releasedTotal: milestones.filter((m) => m.status === 'released' || m.status === 'approved').reduce((s, m) => s + (m.amount || 0), 0),
  };

  return new ApiResponse(
    200,
    { campaign, applications, milestones, transactions: [...transactions, ...milestoneTx], summary },
    'Campaign details'
  ).send(res);
});

async function brandUserId(campaign) {
  const brand = await BrandProfile.findById(campaign.brand).select('user');
  return brand?.user || null;
}

/** PATCH /api/admin/campaigns/:id/approve — makes it public. */
const approveCampaign = catchAsync(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (campaign.approvalStatus !== 'pending') throw ApiError.badRequest('Only campaigns waiting for review can be approved');

  const settings = await SiteSettings.getSingleton();
  campaign.approvalStatus = 'approved';
  campaign.rejectionReason = '';
  campaign.reviewedAt = new Date();
  campaign.reviewedBy = req.user._id;
  campaign.publishedAt = new Date();
  // Early-access window starts when it actually goes public.
  campaign.publicVisibleAt = new Date(Date.now() + settings.creatorEarlyAccessHours * 3600 * 1000);
  if (campaign.status === CAMPAIGN_STATUS.DRAFT) campaign.status = CAMPAIGN_STATUS.OPEN;
  await campaign.save();

  const userId = await brandUserId(campaign);
  if (userId) {
    await notificationService
      .notify({
        userId,
        fromUser: req.user._id,
        type: 'campaign_update',
        title: 'Campaign approved 🎉',
        message: `"${campaign.title}" is now live and creators can apply.`,
        relatedModel: 'Campaign',
        relatedId: campaign._id,
      })
      .catch(() => {});
  }

  return new ApiResponse(200, campaign, 'Campaign approved and live').send(res);
});

/** PATCH /api/admin/campaigns/:id/reject { reason } — back to draft, slot refunded. */
const rejectCampaign = catchAsync(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5) throw ApiError.badRequest('Tell the brand why (at least 5 characters)');

  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (campaign.approvalStatus !== 'pending') throw ApiError.badRequest('Only campaigns waiting for review can be rejected');
  if (campaign.applicantCount > 0 || campaign.assignedCreator) {
    throw ApiError.conflict('This campaign already has proposals — it can’t be sent back');
  }

  campaign.approvalStatus = 'rejected';
  campaign.rejectionReason = reason.slice(0, 500);
  campaign.reviewedAt = new Date();
  campaign.reviewedBy = req.user._id;
  campaign.status = CAMPAIGN_STATUS.DRAFT; // brand can fix and submit again
  campaign.publishedAt = null;
  campaign.publicVisibleAt = null;
  await campaign.save();

  await BrandProfile.updateOne({ _id: campaign.brand, totalCampaigns: { $gt: 0 } }, { $inc: { totalCampaigns: -1 } });

  const userId = await brandUserId(campaign);
  if (userId) {
    await subscriptionService.releaseBrandCampaignSlot(userId).catch(() => {});
    await notificationService
      .notify({
        userId,
        fromUser: req.user._id,
        type: 'campaign_update',
        title: 'Campaign needs changes',
        message: `"${campaign.title}" wasn't approved: ${reason}. Edit it and submit again.`,
        relatedModel: 'Campaign',
        relatedId: campaign._id,
      })
      .catch(() => {});
  }

  return new ApiResponse(200, campaign, 'Campaign sent back to the brand').send(res);
});

/** PATCH /api/admin/campaigns/:id/unpublish { reason } — takes a live campaign down. */
const unpublishCampaign = catchAsync(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5) throw ApiError.badRequest('Tell the brand why (at least 5 characters)');

  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (campaign.assignedCreator) throw ApiError.conflict('A creator is already hired — resolve it through milestones/disputes instead');
  if (campaign.status !== CAMPAIGN_STATUS.OPEN) throw ApiError.badRequest('Only open campaigns can be taken down');

  campaign.approvalStatus = 'rejected';
  campaign.rejectionReason = reason.slice(0, 500);
  campaign.reviewedAt = new Date();
  campaign.reviewedBy = req.user._id;
  await campaign.save();

  const userId = await brandUserId(campaign);
  if (userId) {
    await notificationService
      .notify({
        userId,
        fromUser: req.user._id,
        type: 'campaign_update',
        title: 'Campaign taken down',
        message: `"${campaign.title}" was removed from Fanitt: ${reason}`,
        relatedModel: 'Campaign',
        relatedId: campaign._id,
      })
      .catch(() => {});
  }
  // Tell creators who applied.
  const apps = await Application.find({ campaign: campaign._id, status: 'pending' }).select('creator');
  const creators = await CreatorProfile.find({ _id: { $in: apps.map((a) => a.creator) } }).select('user');
  for (const c of creators) {
    // eslint-disable-next-line no-await-in-loop
    await notificationService
      .notify({
        userId: c.user,
        type: 'campaign_update',
        title: 'Campaign closed',
        message: `"${campaign.title}" is no longer available.`,
        relatedModel: 'Campaign',
        relatedId: campaign._id,
      })
      .catch(() => {});
  }

  return new ApiResponse(200, campaign, 'Campaign taken down').send(res);
});

/** GET/PATCH /api/admin/campaigns/rules — min budget + approval switch. */
const getRules = catchAsync(async (req, res) => {
  const s = await SiteSettings.getSingleton();
  return new ApiResponse(200, { minCampaignBudget: s.minCampaignBudget, requireCampaignApproval: s.requireCampaignApproval }, 'Rules').send(res);
});

const updateRules = catchAsync(async (req, res) => {
  const s = await SiteSettings.getSingleton();
  if (req.body.minCampaignBudget !== undefined) {
    const value = Number(req.body.minCampaignBudget);
    if (!Number.isFinite(value) || value < 0) throw ApiError.badRequest('Minimum budget must be 0 or more');
    s.minCampaignBudget = Math.round(value);
  }
  if (req.body.requireCampaignApproval !== undefined) s.requireCampaignApproval = Boolean(req.body.requireCampaignApproval);
  await s.save();
  return new ApiResponse(200, { minCampaignBudget: s.minCampaignBudget, requireCampaignApproval: s.requireCampaignApproval }, 'Rules updated').send(res);
});

module.exports = {
  listCampaigns,
  getCampaignDetails,
  approveCampaign,
  rejectCampaign,
  unpublishCampaign,
  getRules,
  updateRules,
};