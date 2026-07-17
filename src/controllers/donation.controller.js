const { Donation, Session, Transaction } = require('../models');
const paymentService = require('../services/payment.service');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { TRANSACTION_TYPE, TRANSACTION_STATUS } = require('../constants/enums');

/** POST /api/donations/create-order — fan initiates a donation during a live session */
const createDonationOrder = catchAsync(async (req, res) => {
  const { sessionId, amount, message } = req.body;

  const session = await Session.findById(sessionId).populate('creator');
  if (!session) throw ApiError.notFound('Session not found');

  const order = await paymentService.createOrder(amount, `donation_${sessionId}_${Date.now()}`, {
    sessionId,
    fromUser: String(req.user._id),
    message: message || '',
  });

  return new ApiResponse(200, { order }, 'Complete payment to send donation').send(res);
});

/** POST /api/donations/verify — confirms the donation payment and credits the creator */
const verifyDonation = catchAsync(async (req, res) => {
  const { sessionId, amount, message, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

  const isValid = paymentService.verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature });
  if (!isValid) throw ApiError.badRequest('Payment verification failed');

  const session = await Session.findById(sessionId).populate('creator');
  if (!session) throw ApiError.notFound('Session not found');

  const { platformCommission, netAmount } = await walletService.splitEarnings(amount, session.creator._id);

  const transaction = await Transaction.create({
    type: TRANSACTION_TYPE.DONATION,
    status: TRANSACTION_STATUS.SUCCESS,
    from: req.user._id,
    to: session.creator.user,
    amount,
    platformCommission,
    netAmount,
    relatedModel: 'Session',
    relatedId: session._id,
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  });

  await walletService.creditCreator(session.creator._id, netAmount);

  const donation = await Donation.create({
    session: sessionId,
    fromUser: req.user._id,
    toCreator: session.creator._id,
    amount,
    message,
    transaction: transaction._id,
  });

  await notificationService.notify({
    userId: session.creator.user,
    type: 'donation_received',
    title: 'New donation received',
    message: `You received ₹${(netAmount / 100).toLocaleString('en-IN')} during "${session.title}".`,
    relatedModel: 'Session',
    relatedId: session._id,
  });

  return new ApiResponse(201, donation, 'Donation sent').send(res);
});

const getSessionDonations = catchAsync(async (req, res) => {
  const donations = await Donation.find({ session: req.params.sessionId })
    .populate('fromUser', 'name avatarUrl')
    .sort({ createdAt: -1 });

  return new ApiResponse(200, donations, 'Donations fetched').send(res);
});

module.exports = { createDonationOrder, verifyDonation, getSessionDonations };
