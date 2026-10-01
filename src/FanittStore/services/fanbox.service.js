const mongoose = require('mongoose');
const { CreatorProfile, User } = require('../../models');
const ApiError = require('../../utils/apiError');
const { Store } = require('../models');
const { ORDER_ITEM, FANBOX, STORE_STATUS } = require('../constants');
const orderService = require('./order.service');

// FanBox = a tip to a creator, from anywhere (profile, store, live…).
// Paid like any store item (Razorpay or wallet). The FanBox fee
// (settings.fanboxFeePercent, default 3%) is taken when it's credited.

async function resolveCreator({ creatorId, storeId }) {
  if (storeId) {
    if (!mongoose.isValidObjectId(storeId)) throw ApiError.notFound('Creator not found');
    const store = await Store.findById(storeId);
    if (!store) throw ApiError.notFound('Creator not found');
    const creator = await CreatorProfile.findById(store.creator).select('_id user');
    return { creator, store };
  }
  if (!mongoose.isValidObjectId(creatorId)) throw ApiError.notFound('Creator not found');
  const creator = await CreatorProfile.findById(creatorId).select('_id user');
  if (!creator) throw ApiError.notFound('Creator not found');
  const store = await Store.findOne({ creator: creator._id });
  return { creator, store };
}

/** Starts a FanBox payment. Returns what orderService.startCheckout returns. */
async function startFanBox(sender, { creatorId, storeId, amount, message = '', context = 'profile', payWith }) {
  const { creator, store } = await resolveCreator({ creatorId, storeId });
  if (!creator) throw ApiError.notFound('Creator not found');
  if (String(creator.user) === String(sender._id)) throw ApiError.badRequest("You can't send a FanBox to yourself");
  if (!Number.isInteger(amount) || amount < FANBOX.MIN_AMOUNT || amount > FANBOX.MAX_AMOUNT) {
    throw ApiError.badRequest(`FanBox amount must be between ₹${FANBOX.MIN_AMOUNT / 100} and ₹${FANBOX.MAX_AMOUNT / 100}`);
  }
  if (store && store.status === STORE_STATUS.SUSPENDED) throw ApiError.badRequest('This creator cannot receive FanBox right now');

  const receiver = await User.findById(creator.user).select('name isActive isSuspended');
  if (!receiver || receiver.isActive === false || receiver.isSuspended) throw ApiError.badRequest('This creator cannot receive FanBox right now');

  return orderService.startCheckout(
    sender,
    {
      // Only attach the store when it's active — the tip still reaches the
      // creator either way.
      store: store && store.status === STORE_STATUS.ACTIVE ? store : null,
      seller: creator.user,
      sellerName: receiver.name,
      itemType: ORDER_ITEM.FANBOX,
      itemId: creator._id,
      itemTitle: `FanBox for ${receiver.name}`,
      amount,
      message: String(message || '').slice(0, 200),
      context: FANBOX.CONTEXTS.includes(context) ? context : 'other',
      description: `FanBox for ${receiver.name}`,
      reusePending: false,
    },
    { payWith }
  );
}

module.exports = { startFanBox };
