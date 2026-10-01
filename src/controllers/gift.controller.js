const { Gift } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

// FanBox (gifts). The old endpoints keep the same request/response shape
// for existing website/app builds, but now run through the Fanitt Store
// FanBox flow (src/FanittStore/services/fanbox.service.js), which:
//  - binds the amount to the Razorpay order (the app can't change it),
//  - credits each payment exactly once,
//  - applies the FanBox fee set in the admin panel.

// Lazy requires: the store module registers its own models on load.
const store = () => ({
  fanbox: require('../FanittStore/services/fanbox.service'),
  orders: require('../FanittStore/services/order.service'),
  models: require('../FanittStore/models'),
});

/** POST /api/gifts/create-order { creatorId, amount, message } */
const createGiftOrder = catchAsync(async (req, res) => {
  const { creatorId, amount, message } = req.body;
  const value = Number(amount);
  if (!Number.isInteger(value) || value <= 0) throw ApiError.badRequest('Invalid gift amount');

  const result = await store().fanbox.startFanBox(req.user, { creatorId, amount: value, message, context: 'profile' });
  if (result.paid) {
    // Only happens for wallet payments, which this old endpoint never requests.
    return new ApiResponse(201, { order: null, storeOrderId: result.order._id, paid: true }, 'FanBox sent').send(res);
  }
  return new ApiResponse(
    200,
    {
      // Same shape as before: a Razorpay order the checkout opens.
      order: { id: result.razorpay.orderId, amount: result.razorpay.amount, currency: result.razorpay.currency },
      storeOrderId: result.order._id,
      keyId: result.razorpay.keyId,
    },
    'Complete payment to send your FanBox gift'
  ).send(res);
});

/** POST /api/gifts/verify { razorpayOrderId, razorpayPaymentId, razorpaySignature } */
const verifyGift = catchAsync(async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) throw ApiError.badRequest('Payment details are missing');

  const { StoreOrder } = store().models;
  const order = await StoreOrder.findOne({ razorpayOrderId, buyer: req.user._id, itemType: 'fanbox' });
  if (!order) throw ApiError.notFound('Gift order not found');

  const paid = await store().orders.verifyPayment(req.user._id, order._id, { razorpayOrderId, razorpayPaymentId, razorpaySignature });
  const gift = paid.transaction ? await Gift.findOne({ transaction: paid.transaction }) : null;
  return new ApiResponse(201, gift || { _id: paid._id, amount: paid.amount, message: paid.message }, 'Gift sent').send(res);
});

const getCreatorGifts = catchAsync(async (req, res) => {
  const gifts = await Gift.find({ toCreator: req.params.creatorId })
    .populate('fromUser', 'name avatarUrl')
    .sort({ createdAt: -1 })
    .limit(50);

  return new ApiResponse(200, gifts, 'Gifts fetched').send(res);
});

module.exports = { createGiftOrder, verifyGift, getCreatorGifts };