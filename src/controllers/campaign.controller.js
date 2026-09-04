const { Campaign, Application, BrandProfile, CreatorProfile, User, SiteSettings } = require('../models');
const paymentService = require('../services/payment.service');
const escrowService = require('../services/escrow.service');
const notificationService = require('../services/notification.service');
const subscriptionService = require('../services/subscription.service');
const milestoneService = require('../services/milestone.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const {
  ROLES,
  CAMPAIGN_STATUS,
  APPLICATION_STATUS,
  CAMPAIGN_TYPE,
  LOCATION_TYPE,
  CAMPAIGN_VISIBILITY_TIER,
  CREATOR_CAMPAIGN_ACCESS,
} = require('../constants/enums');

const listCampaigns = catchAsync(async (req, res) => {
  const { category, status = CAMPAIGN_STATUS.OPEN, page = 1, limit = 20 } = req.query;

  const filter = {};
  if (category) filter.category = category;
  if (status) filter.status = status;

  const campaigns = await Campaign.find(filter)
    .populate({ path: 'brand', populate: { path: 'user', select: 'name avatarUrl' } })
    .populate('category', 'label icon')
    .sort({ isFeatured: -1, createdAt: -1 })
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
  if (campaign.status === CAMPAIGN_STATUS.DRAFT) throw ApiError.notFound('Campaign not found');

  return new ApiResponse(200, campaign, 'Campaign fetched').send(res);
});

const getMyDraftCampaign = catchAsync(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).populate('brand').populate('category', 'label icon');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');

  // TEMPORARY-DEBUG — remove once milestone data is confirmed flowing correctly
  console.log('[DEBUG getMyDraftCampaign] milestoneCount:', campaign.milestoneCount, '| milestoneTitles:', campaign.milestoneTitles);

  return new ApiResponse(200, campaign, 'Draft fetched').send(res);
});

const createDraftCampaign = catchAsync(async (req, res) => {
  const brand = await BrandProfile.findOne({ user: req.user._id });
  if (!brand) throw ApiError.notFound('Brand profile not found');

  const { title, campaignType, locationType, locationValue } = req.body;

  const campaign = await Campaign.create({
    brand: brand._id,
    title,
    campaignType,
    locationType,
    locationValue,
    location: locationType === LOCATION_TYPE.PAN_INDIA ? 'Pan India' : locationValue || 'Remote',
    status: CAMPAIGN_STATUS.DRAFT,
  });

  return new ApiResponse(201, campaign, 'Draft created').send(res);
});

const updateDraftCampaign = catchAsync(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).populate('brand');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');
  if (campaign.status !== CAMPAIGN_STATUS.DRAFT) throw ApiError.conflict('Only draft campaigns can be edited this way');

  // TEMPORARY-DEBUG — remove once milestone data is confirmed flowing correctly
  console.log('[DEBUG updateDraftCampaign] req.body.milestoneCount:', req.body.milestoneCount, '| req.body.milestoneTitles:', req.body.milestoneTitles);

  // applicantLimit / dailyApplicantLimit are only settable if the brand's
  // active plan allows it — silently dropped (not an error) if they're
  // not entitled to it, so the rest of the draft update still succeeds.
  // One plan lookup covers both fields.
  if (req.body.applicantLimit !== undefined || req.body.dailyApplicantLimit !== undefined) {
    const brandPlan = await subscriptionService.getBrandPlanFields(req.user._id);
    if (brandPlan.canSetApplicantLimit) {
      if (req.body.applicantLimit !== undefined) campaign.applicantLimit = req.body.applicantLimit;
      if (req.body.dailyApplicantLimit !== undefined) campaign.dailyApplicantLimit = req.body.dailyApplicantLimit;
    }
  }

  // Upwork-style flow: how many equal milestones the budget splits into
  // (1-4). Clamped rather than rejected outright — a stray value like 0
  // or 7 just gets pulled back into range instead of failing the whole
  // draft update.
  if (req.body.milestoneCount !== undefined) {
    campaign.milestoneCount = Math.min(4, Math.max(1, Number(req.body.milestoneCount) || 2));
  }
  if (req.body.milestoneTitles !== undefined) {
    campaign.milestoneTitles = Array.isArray(req.body.milestoneTitles) ? req.body.milestoneTitles.slice(0, 4) : [];
  }

  const editableFields = [
    'title',
    'campaignType',
    'locationType',
    'locationValue',
    'costPerInfluencer',
    'description',
    'category',
    'creatorRequirement',
    'durationLabel',
    'influencerCategories',
    'genderTarget',
    'ageRange',
    'minFollowers',
    'maxInfluencers',
    'dos',
    'donts',
    'deliverables',
  ];
  editableFields.forEach((field) => {
    if (req.body[field] !== undefined) campaign[field] = req.body[field];
  });

  if (req.body.locationType !== undefined || req.body.locationValue !== undefined) {
    campaign.location = campaign.locationType === LOCATION_TYPE.PAN_INDIA ? 'Pan India' : campaign.locationValue || 'Remote';
  }

  if (campaign.campaignType === CAMPAIGN_TYPE.PAID) {
    campaign.budget = (campaign.costPerInfluencer || 0) * (campaign.maxInfluencers || 1);
  } else {
    campaign.budget = 0;
  }

  await campaign.save();

  // TEMPORARY-DEBUG — remove once milestone data is confirmed flowing correctly
  console.log('[DEBUG updateDraftCampaign] SAVED campaign.milestoneCount:', campaign.milestoneCount, '| campaign.milestoneTitles:', campaign.milestoneTitles);

  return new ApiResponse(200, campaign, 'Draft updated').send(res);
});

const addProduct = catchAsync(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).populate('brand');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');

  const { name, description, quantity, price } = req.body;

  campaign.products.push({
    name,
    description,
    quantity,
    price,
    imageUrl: req.file?.path || '',
  });
  await campaign.save();

  return new ApiResponse(201, campaign.products[campaign.products.length - 1], 'Product added').send(res);
});

const removeProduct = catchAsync(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).populate('brand');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');

  campaign.products.pull(req.params.productId);
  await campaign.save();

  return new ApiResponse(200, null, 'Product removed').send(res);
});

const uploadCampaignMedia = catchAsync(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).populate('brand');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');

  if (req.files?.campaignImage?.[0]) {
    campaign.campaignImageUrl = req.files.campaignImage[0].path;
  }
  if (req.files?.media?.length) {
    campaign.sampleMedia.push(...req.files.media.map((f) => f.path));
  }
  await campaign.save();

  return new ApiResponse(
    200,
    { campaignImageUrl: campaign.campaignImageUrl, sampleMedia: campaign.sampleMedia },
    'Media uploaded'
  ).send(res);
});

function assertPublishable(campaign) {
  const missing = [];
  if (!campaign.title || campaign.title.trim().length < 3) missing.push('Campaign name');
  if (!campaign.description || campaign.description.trim().length < 10) missing.push('Description');
  if (campaign.campaignType === CAMPAIGN_TYPE.PAID && (!campaign.costPerInfluencer || campaign.costPerInfluencer < 100)) {
    missing.push('Cost per influencer');
  }
  if (campaign.campaignType === CAMPAIGN_TYPE.BARTER && campaign.products.length === 0) {
    missing.push('At least one barter product');
  }
  if (missing.length) throw ApiError.badRequest(`Please complete before publishing: ${missing.join(', ')}`);
}

// --- Final step: go live. No fee — publishing itself is free. What DOES
// happen here: (1) the brand's plan campaign-post quota is CHECKED
// up front (throws early if exhausted, before any write happens), (2)
// the campaign is stamped with the visibility tier / featured flag /
// early-access cutoff that flow from their plan, (3) the quota slot is
// only actually consumed (finalizeBrandCampaignUsage) after the campaign
// and brand doc have both saved successfully — so a save failure midway
// never burns a slot the brand didn't get. Escrow only comes into play
// later, when the brand accepts a creator's bid (see
// initiateEscrowFunding/verifyEscrowPayment below). ---
const publishCampaign = catchAsync(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).populate('brand');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');
  if (campaign.status !== CAMPAIGN_STATUS.DRAFT) throw ApiError.conflict('This campaign has already been published');

  assertPublishable(campaign);

  const { sub: brandSub, plan: brandPlan } = await subscriptionService.checkBrandCampaignQuota(req.user._id);
  const settings = await SiteSettings.getSingleton();

  campaign.status = CAMPAIGN_STATUS.OPEN;
  campaign.publishedAt = new Date();
  campaign.visibilityTier = brandPlan.campaignVisibilityTier;
  campaign.isFeatured = brandPlan.isFeaturedListing;
  campaign.publicVisibleAt = new Date(Date.now() + settings.creatorEarlyAccessHours * 3600 * 1000);
  await campaign.save();

  campaign.brand.totalCampaigns += 1;
  await campaign.brand.save();

  // Only consume the slot now that publish has fully succeeded.
  await subscriptionService.finalizeBrandCampaignUsage(brandSub);

  return new ApiResponse(200, campaign, 'Campaign published').send(res);
});

// --- A creator applying is gated by two subscription checks up front
// (exclusive-campaign access, early-access timing — unchanged), then the
// proposal quota is CHECKED (read-only) before the Application is
// created. The quota/wallet is only actually consumed
// (finalizeCreatorProposal) after the Application and the campaign's
// applicantCount have both saved — if that finalize step throws (e.g. a
// wallet-debit race), the Application and applicantCount bump are rolled
// back so nothing is left half-charged. ---
const applyToCampaign = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.CREATOR) throw ApiError.forbidden('Only creators can apply to campaigns');

  const { pitch, quotedAmount, portfolioLinks, deliveryTimeline } = req.body;

  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (campaign.status !== CAMPAIGN_STATUS.OPEN) throw ApiError.badRequest('This campaign is no longer accepting applications');

  const creatorPlan = await subscriptionService.getCreatorPlanFields(req.user._id);

  if (campaign.visibilityTier === CAMPAIGN_VISIBILITY_TIER.EXCLUSIVE && creatorPlan.campaignAccessTier !== CREATOR_CAMPAIGN_ACCESS.ALL) {
    throw ApiError.forbidden('This is an exclusive campaign for Pro creators. Upgrade your plan to apply.', [], 'EXCLUSIVE_CAMPAIGN_LOCKED');
  }

  if (!creatorPlan.hasEarlyAccess && campaign.publicVisibleAt && new Date() < campaign.publicVisibleAt) {
    throw ApiError.forbidden('This campaign is not open to your plan yet — please check back later, or upgrade for early access.');
  }

  if (campaign.applicantLimit != null && campaign.applicantCount >= campaign.applicantLimit) {
    throw ApiError.conflict('This campaign has reached its applicant limit.');
  }

  // Point 11: daily applicant cap (Pro/Exclusive brands only, set via
  // updateDraftCampaign above). Computed dynamically against today's
  // applications rather than a stored counter, so there's nothing to
  // reset or drift — "today" is the server's local calendar day.
  if (campaign.dailyApplicantLimit != null) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todaysApplicantCount = await Application.countDocuments({
      campaign: campaign._id,
      createdAt: { $gte: startOfToday },
    });
    if (todaysApplicantCount >= campaign.dailyApplicantLimit) {
      throw ApiError.conflict("This campaign has reached today's applicant limit — please check back tomorrow.");
    }
  }

  const creator = await CreatorProfile.findOne({ user: req.user._id });
  if (!creator) throw ApiError.notFound('Creator profile not found');

  const existing = await Application.findOne({ campaign: campaign._id, creator: creator._id });
  if (existing) throw ApiError.conflict('You have already applied to this campaign');

  // Check quota before creating anything — throws early with no cleanup needed.
  const { needsExtraCharge } = await subscriptionService.checkCreatorProposalQuota(req.user._id);

  const application = await Application.create({
    campaign: campaign._id,
    creator: creator._id,
    pitch,
    quotedAmount: quotedAmount ?? null,
    portfolioLinks: (portfolioLinks || []).filter(Boolean),
    deliveryTimeline: deliveryTimeline || '',
  });

  campaign.applicantCount += 1;
  await campaign.save();

  // Only now — application + count both confirmed saved — actually
  // consume the quota / charge the extra-proposal fee. If this fails,
  // roll back the application and count so nothing is left inconsistent.
  try {
    await subscriptionService.finalizeCreatorProposal(req.user._id, needsExtraCharge);
  } catch (err) {
    await Application.deleteOne({ _id: application._id });
    campaign.applicantCount = Math.max(0, campaign.applicantCount - 1);
    await campaign.save();
    throw err;
  }

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

// --- Point 8: rule-based "AI-suggested" campaigns for Pro/Exclusive
// creators only. No LLM call — this scores each open, not-yet-applied
// campaign against the creator's own profile (category, location,
// skills) and returns the top matches. Hard filters (follower minimum,
// applicant limit, early-access timing) exclude a campaign entirely;
// the score below only ranks what's left. ---
const getSuggestedCampaigns = catchAsync(async (req, res) => {
  const creatorPlan = await subscriptionService.getCreatorPlanFields(req.user._id);
  if (creatorPlan.campaignAccessTier !== CREATOR_CAMPAIGN_ACCESS.ALL) {
    throw ApiError.forbidden(
      'AI-suggested campaigns are a Pro feature — upgrade your plan to unlock personalized matches.',
      [],
      'PRO_FEATURE_LOCKED'
    );
  }

  const creator = await CreatorProfile.findOne({ user: req.user._id }).populate('category', 'label icon');
  if (!creator) throw ApiError.notFound('Creator profile not found');

  const appliedCampaignIds = await Application.find({ creator: creator._id }).distinct('campaign');

  // Hard filters, applied as a DB query (not post-fetch) so pagination-free
  // scoring below only ever runs over campaigns the creator could actually apply to.
  const candidateFilter = {
    status: CAMPAIGN_STATUS.OPEN,
    _id: { $nin: appliedCampaignIds },
    $or: [{ minFollowers: null }, { minFollowers: { $lte: creator.followerCount || 0 } }],
  };
  if (!creatorPlan.hasEarlyAccess) {
    candidateFilter.$and = [{ $or: [{ publicVisibleAt: null }, { publicVisibleAt: { $lte: new Date() } }] }];
  }

  const candidates = await Campaign.find(candidateFilter)
    .populate({ path: 'brand', populate: { path: 'user', select: 'name avatarUrl' } })
    .populate('category', 'label icon')
    .sort({ createdAt: -1 })
    .limit(200); // cap the scoring pool so this stays fast even with many open campaigns

  const creatorSkills = (creator.skills || []).map((s) => s.toLowerCase());
  const creatorLocation = (creator.location || '').toLowerCase();

  const scored = candidates
    .filter((c) => c.applicantLimit == null || c.applicantCount < c.applicantLimit)
    .map((c) => {
      let score = 0;
      const reasons = [];

      if (creator.category && c.category && String(c.category._id) === String(creator.category._id)) {
        score += 40;
        reasons.push(`Matches your category (${c.category.label})`);
      }

      if (c.locationType === LOCATION_TYPE.PAN_INDIA) {
        score += 10;
      } else if (creatorLocation && c.location && c.location.toLowerCase().includes(creatorLocation)) {
        score += 20;
        reasons.push('Matches your location');
      }

      const matchedSkills = (c.influencerCategories || []).filter((tag) => creatorSkills.includes(tag.toLowerCase()));
      if (matchedSkills.length > 0) {
        score += Math.min(20, matchedSkills.length * 5);
        reasons.push(`Matches ${matchedSkills.length} of your skill${matchedSkills.length === 1 ? '' : 's'}`);
      }

      if (c.minFollowers != null) {
        reasons.push('You meet the follower requirement');
      }

      return { campaign: c, matchScore: score, matchReasons: reasons };
    })
    .sort((a, b) => b.matchScore - a.matchScore || new Date(b.campaign.createdAt) - new Date(a.campaign.createdAt))
    .slice(0, 10);

  return new ApiResponse(200, scored, 'Suggested campaigns fetched').send(res);
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
  const { decision, feedback, rejectionReason } = req.body;
  const campaign = await Campaign.findById(req.params.id).populate('brand');
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (!campaign.brand.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this campaign');

  if (decision === 'rejected' && !rejectionReason?.trim()) {
    throw ApiError.badRequest('Please provide a reason for declining this proposal');
  }

  const application = await Application.findById(req.params.appId);
  if (!application) throw ApiError.notFound('Application not found');

  application.status = decision === 'accepted' ? APPLICATION_STATUS.ACCEPTED : APPLICATION_STATUS.REJECTED;
  application.respondedAt = new Date();
  if (feedback) application.feedback = feedback;
  if (decision === 'rejected') application.rejectionReason = rejectionReason.trim();
  await application.save();

  if (decision === 'accepted') {
    campaign.assignedCreator = application.creator;

    // Bug fix: if the creator quoted a different (usually lower) amount
    // than the brand's posted budget, that quote is what they actually
    // agreed to work for — milestones must split THAT amount, not the
    // original posted budget. Without this, a creator who bid ₹8 on a
    // ₹12 campaign still ends up with milestones totalling ₹12.
    if (campaign.campaignType === CAMPAIGN_TYPE.PAID && application.quotedAmount != null && application.quotedAmount > 0) {
      campaign.budget = application.quotedAmount;
    }

    await campaign.save();

    // Point 12: milestone-based escrow only applies to paid campaigns —
    // a barter campaign has no cash budget to split into an
    // advance/final payment, so there's nothing to create here.
    if (campaign.campaignType === CAMPAIGN_TYPE.PAID && campaign.budget > 0) {
      await milestoneService.createInitialMilestones(campaign);
    }
  }

  await notificationService.notify({
    userId: (await CreatorProfile.findById(application.creator)).user,
    type: 'proposal_status_update',
    title: decision === 'accepted' ? 'Proposal accepted!' : 'Proposal declined',
    message:
      decision === 'accepted'
        ? `You've been accepted for "${campaign.title}". Waiting for the brand to fund escrow.`
        : `Your proposal for "${campaign.title}" was declined: ${rejectionReason.trim()}`,
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
  getSuggestedCampaigns,
  getCampaignById,
  getMyDraftCampaign,
  createDraftCampaign,
  updateDraftCampaign,
  addProduct,
  removeProduct,
  uploadCampaignMedia,
  publishCampaign,
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