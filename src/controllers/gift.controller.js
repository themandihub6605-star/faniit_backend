const { Gift, CreatorProfile, Transaction } = require('../models');
const paymentService = require('../services/payment.service');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { TRANSACTION_TYPE, TRANSACTION_STATUS } = require('../constants/enums');

const createGiftOrder = catchAsync(async (req, res) => {
  const { creatorId, amount, message } = req.body;
  if (!amount || amount <= 0) throw ApiError.badRequest('Invalid gift amount');

  const creator = await CreatorProfile.findById(creatorId);
  if (!creator) throw ApiError.notFound('Creator not found');

  const order = await paymentService.createOrder(amount, `gift_${creatorId}_${Date.now()}`, {
    creatorId,
    fromUser: String(req.user._id),
    message: message || '',
  });

  return new ApiResponse(200, { order }, 'Complete payment to send your FanBox gift').send(res);
});

const verifyGift = catchAsync(async (req, res) => {
  const { creatorId, amount, message, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

  const isValid = paymentService.verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature });
  if (!isValid) throw ApiError.badRequest('Payment verification failed');

  const creator = await CreatorProfile.findById(creatorId).populate('user');
  if (!creator) throw ApiError.notFound('Creator not found');

  const { platformCommission, netAmount } = await walletService.splitEarnings(amount, creator._id);

  const transaction = await Transaction.create({
    type: TRANSACTION_TYPE.GIFT,
    status: TRANSACTION_STATUS.SUCCESS,
    from: req.user._id,
    to: creator.user._id,
    amount,
    platformCommission,
    netAmount,
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  });

  await walletService.creditCreator(creator._id, netAmount);

  const gift = await Gift.create({
    fromUser: req.user._id,
    toCreator: creator._id,
    amount,
    message,
    transaction: transaction._id,
  });

  await notificationService.notify({
    userId: creator.user._id,
    type: 'gift_received',
    title: 'You received a FanBox gift!',
    message: `₹${(netAmount / 100).toLocaleString('en-IN')} from a fan${message ? `: "${message}"` : '.'}`,
  });

  return new ApiResponse(201, gift, 'Gift sent').send(res);
});

const getCreatorGifts = catchAsync(async (req, res) => {
  const gifts = await Gift.find({ toCreator: req.params.creatorId })
    .populate('fromUser', 'name avatarUrl')
    .sort({ createdAt: -1 })
    .limit(50);

  return new ApiResponse(200, gifts, 'Gifts fetched').send(res);
});

module.exports = { createGiftOrder, verifyGift, getCreatorGifts };