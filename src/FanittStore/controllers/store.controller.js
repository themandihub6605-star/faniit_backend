const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const ApiError = require('../../utils/apiError');
const { Store } = require('../models');
const { STORE_STATUS, KYC_STATUS } = require('../constants');
const storeService = require('../services/store.service');
const settingsService = require('../services/settings.service');
const storage = require('../services/storage.service');
const { ownerStore } = require('../utils/serialize');
const log = require('../utils/logger');
const subscriptionService = require('../../services/subscription.service');

// Creator side: open a store and walk the four setup steps.

/** Is the creator on a paid Fanitt plan right now? (free default plan = no) */
async function subscriptionOf(userId) {
  try {
    const sub = await subscriptionService.getOrCreateActiveSubscription(userId, 'creator');
    const plan = sub?.plan || {};
    const active = sub?.status === 'active' && (plan.price || 0) > 0 && (!sub.currentPeriodEnd || new Date(sub.currentPeriodEnd) > new Date());
    return { hasSubscription: active, planName: plan.name || '' };
  } catch (err) {
    log.warn('store.subscription_check_failed', { userId: String(userId), message: err?.message });
    return { hasSubscription: false, planName: '' };
  }
}

async function respondWithMyStore(res, userId, message, status = 200) {
  const [store, settings, sub] = await Promise.all([
    storeService.findMyStore(userId, { withPrivate: true }),
    settingsService.getSettings(),
    subscriptionOf(userId),
  ]);
  return new ApiResponse(
    status,
    {
      store: ownerStore(store),
      steps: storeService.setupSteps(store, settings),
      terms: { version: settings.termsVersion, text: settings.termsText },
      fees: { storeFeePercent: settings.storeFeePercent, fanboxFeePercent: settings.fanboxFeePercent },
      access: { subscriptionRequired: Boolean(settings.requireSubscription), hasSubscription: sub.hasSubscription, planName: sub.planName },
    },
    message
  ).send(res);
}

/** GET /api/store/me — my store (or null) + setup progress. */
const getMyStore = catchAsync(async (req, res) => respondWithMyStore(res, req.user._id, 'Store fetched'));

/** POST /api/store/me — step 1, creates the store. */
const createStore = catchAsync(async (req, res) => {
  const creator = await storeService.requireCreatorProfile(req.user._id);
  if (await Store.exists({ user: req.user._id })) throw ApiError.conflict('You already have a store', [], 'STORE_EXISTS');

  // Admin switch (Fanitt Store → Settings): new stores need a paid plan.
  const settings = await settingsService.getSettings();
  if (settings.requireSubscription) {
    const sub = await subscriptionOf(req.user._id);
    if (!sub.hasSubscription) {
      throw new ApiError(403, 'Choose a Fanitt plan (monthly or yearly) to open your store', [], 'SUBSCRIPTION_REQUIRED');
    }
  }

  const slug = await storeService.uniqueSlug(creator.slug || req.body.name);
  const store = await Store.create({
    user: req.user._id,
    creator: creator._id,
    slug,
    name: req.body.name,
    tagline: req.body.tagline || '',
    about: req.body.about || '',
    logoUrl: req.user.avatarUrl || '',
  });
  log.info('store.created', { storeId: String(store._id), userId: String(req.user._id) });
  return respondWithMyStore(res, req.user._id, 'Store created', 201);
});

/** PATCH /api/store/me — edit profile / open-close. */
const updateStore = catchAsync(async (req, res) => {
  const store = await storeService.requireMyStore(req.user._id);
  ['name', 'tagline', 'about', 'isOpen'].forEach((field) => {
    if (req.body[field] !== undefined) store[field] = req.body[field];
  });
  await store.save();
  return respondWithMyStore(res, req.user._id, 'Store updated');
});

/** POST /api/store/me/logo | /banner — image upload (public). */
const uploadStoreImage = (field) =>
  catchAsync(async (req, res) => {
    if (!req.file?.path) throw ApiError.badRequest('Choose an image to upload');
    const store = await storeService.requireMyStore(req.user._id);
    store[field] = req.file.path;
    await store.save();
    return respondWithMyStore(res, req.user._id, 'Image updated');
  });

/** PUT /api/store/me/payout — step 2. */
const savePayout = catchAsync(async (req, res) => {
  const store = await storeService.requireMyStore(req.user._id, { withPrivate: true });
  const body = req.body;
  store.payout =
    body.method === 'upi'
      ? { method: 'upi', upiId: body.upiId, updatedAt: new Date() }
      : {
          method: 'bank',
          accountHolderName: body.accountHolderName,
          accountNumber: body.accountNumber,
          ifsc: body.ifsc,
          bankName: body.bankName || '',
          updatedAt: new Date(),
        };
  store.hasPayout = true;
  await store.save();
  await storeService.advanceIfReady(store, await settingsService.getSettings());
  log.info('store.payout_saved', { storeId: String(store._id), method: body.method });
  return respondWithMyStore(res, req.user._id, 'Payout details saved');
});

/** POST /api/store/me/kyc — step 3 (multipart: panDocument, idDocument + fields). */
const submitKyc = catchAsync(async (req, res) => {
  const store = await storeService.requireMyStore(req.user._id, { withPrivate: true });
  if (store.kycStatus === KYC_STATUS.VERIFIED) throw ApiError.conflict('Your KYC is already verified');
  if (store.kycStatus === KYC_STATUS.PENDING) throw ApiError.conflict('Your KYC is already under review');

  const panFile = req.files?.panDocument?.[0];
  const idFile = req.files?.idDocument?.[0];
  if (!panFile || !idFile) throw ApiError.badRequest('Upload both your PAN card and your ID proof');

  const uid = String(req.user._id);
  const panKey = storage.buildKey('kyc', uid, `pan-${panFile.originalname}`);
  const idKey = storage.buildKey('kyc', uid, `id-${idFile.originalname}`);
  await storage.putBuffer({ key: panKey, buffer: panFile.buffer, mimeType: panFile.mimetype });
  await storage.putBuffer({ key: idKey, buffer: idFile.buffer, mimeType: idFile.mimetype });

  // Replace any documents from an earlier (rejected) attempt.
  const oldKeys = [store.kyc?.panDocumentKey, store.kyc?.idDocumentKey].filter(Boolean);

  store.kyc = {
    status: KYC_STATUS.PENDING,
    panNumber: req.body.panNumber,
    panName: req.body.panName,
    idType: req.body.idType,
    panDocumentKey: panKey,
    idDocumentKey: idKey,
    submittedAt: new Date(),
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: '',
  };
  store.kycStatus = KYC_STATUS.PENDING;
  if (store.status === STORE_STATUS.REJECTED) store.status = STORE_STATUS.DRAFT;
  await store.save();
  oldKeys.forEach((k) => storage.remove(k));

  await storeService.advanceIfReady(store, await settingsService.getSettings());
  log.info('store.kyc_submitted', { storeId: String(store._id) });
  return respondWithMyStore(res, req.user._id, 'KYC submitted — we’ll review it shortly');
});

/** POST /api/store/me/terms — step 4. */
const acceptTerms = catchAsync(async (req, res) => {
  const settings = await settingsService.getSettings();
  if (req.body.version !== settings.termsVersion) {
    throw ApiError.badRequest('The store terms were updated — read the latest version and accept again', [], 'TERMS_OUTDATED');
  }
  const store = await storeService.requireMyStore(req.user._id);
  store.termsAcceptedAt = new Date();
  store.termsVersion = settings.termsVersion;
  await store.save();
  await storeService.advanceIfReady(store, settings);
  return respondWithMyStore(res, req.user._id, 'Terms accepted');
});

module.exports = { getMyStore, createStore, updateStore, uploadStoreImage, savePayout, submitKyc, acceptTerms };