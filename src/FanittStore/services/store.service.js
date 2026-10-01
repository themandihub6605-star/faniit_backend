const { CreatorProfile, User } = require('../../models');
const ApiError = require('../../utils/apiError');
const { Store } = require('../models');
const { STORE_STATUS, KYC_STATUS } = require('../constants');
const { toSlug } = require('../utils/text');
const { safeNotify } = require('./notify.service');
const log = require('../utils/logger');

// Store lookup + the setup-steps state machine.

async function findMyStore(userId, { withPrivate = false } = {}) {
  let query = Store.findOne({ user: userId });
  if (withPrivate) query = query.select('+payout +kyc');
  return query;
}

/** The store of the current user, or a clear 404. */
async function requireMyStore(userId, options) {
  const store = await findMyStore(userId, options);
  if (!store) throw ApiError.notFound('You have not set up a Fanitt Store yet', [], 'STORE_NOT_FOUND');
  return store;
}

/** For selling actions: the store must be approved and not suspended. */
async function requireActiveStore(userId) {
  const store = await requireMyStore(userId);
  if (store.status !== STORE_STATUS.ACTIVE) {
    throw ApiError.forbidden('Your store is not active yet — finish setup and wait for approval', [], 'STORE_NOT_ACTIVE');
  }
  return store;
}

async function requireCreatorProfile(userId) {
  const creator = await CreatorProfile.findOne({ user: userId }).select('_id slug user');
  if (!creator) throw ApiError.forbidden('Only creators can open a Fanitt Store', [], 'CREATOR_ONLY');
  return creator;
}

async function uniqueSlug(base, excludeId = null) {
  const root = toSlug(base) || 'store';
  let candidate = root;
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const taken = await Store.exists({ slug: candidate, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
    if (!taken) return candidate;
    candidate = `${root}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return `${root}-${Date.now().toString(36)}`;
}

/** Which setup steps are done — drives the app's setup screen. */
function setupSteps(store, settings) {
  const profile = Boolean(store?.name);
  const payout = Boolean(store?.hasPayout);
  const kyc = store ? store.kycStatus !== KYC_STATUS.NOT_SUBMITTED : false;
  const terms = Boolean(store?.termsAcceptedAt) && store?.termsVersion === settings.termsVersion;
  return {
    profile,
    payout,
    kyc,
    kycStatus: store?.kycStatus || KYC_STATUS.NOT_SUBMITTED,
    terms,
    complete: profile && payout && kyc && terms,
  };
}

/**
 * Called after any setup step. When every step is done the store moves to
 * admin review (or straight to active if KYC was already verified — e.g.
 * the creator only re-accepted updated terms).
 */
async function advanceIfReady(store, settings) {
  const steps = setupSteps(store, settings);
  if (!steps.complete) return store;
  if (store.status === STORE_STATUS.SUSPENDED || store.status === STORE_STATUS.ACTIVE) return store;

  if (store.kycStatus === KYC_STATUS.VERIFIED) {
    store.status = STORE_STATUS.ACTIVE;
    store.activatedAt = store.activatedAt || new Date();
    store.statusReason = '';
    await store.save();
    log.info('store.activated', { storeId: String(store._id) });
    return store;
  }

  if (store.kycStatus === KYC_STATUS.PENDING && store.status !== STORE_STATUS.PENDING_REVIEW) {
    store.status = STORE_STATUS.PENDING_REVIEW;
    store.submittedAt = new Date();
    store.statusReason = '';
    await store.save();
    log.info('store.submitted_for_review', { storeId: String(store._id) });

    const admins = await User.find({ role: 'admin' }).select('_id');
    await Promise.all(
      admins.map((a) =>
        safeNotify({
          userId: a._id,
          type: 'store_update',
          title: 'New store waiting for review',
          message: `"${store.name}" finished setup — review the KYC documents.`,
          relatedModel: 'Store',
          relatedId: store._id,
        })
      )
    );
  }
  return store;
}

module.exports = { findMyStore, requireMyStore, requireActiveStore, requireCreatorProfile, uniqueSlug, setupSteps, advanceIfReady };
