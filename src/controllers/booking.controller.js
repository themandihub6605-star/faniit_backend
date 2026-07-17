const { Booking, Session, Transaction } = require('../models');
const paymentService = require('../services/payment.service');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { BOOKING_STATUS, TRANSACTION_TYPE, TRANSACTION_STATUS, SESSION_TYPES } = require('../constants/enums');

/** POST /api/bookings — book a session. Free sessions confirm instantly; paid sessions return a Razorpay order to pay. */
const createBooking = catchAsync(async (req, res) => {
  const { sessionId } = req.body;

  const session = await Session.findById(sessionId).populate('creator');
  if (!session) throw ApiError.notFound('Session not found');
  if (session.isCancelled) throw ApiError.badRequest('This session has been cancelled');
  if (session.bookedCount >= session.maxParticipants) throw ApiError.badRequest('This session is fully booked');

  const existing = await Booking.findOne({ session: sessionId, user: req.user._id });
  if (existing) throw ApiError.conflict('You have already booked this session');

  if (session.type === SESSION_TYPES.FREE) {
    const booking = await Booking.create({
      session: sessionId,
      user: req.user._id,
      status: BOOKING_STATUS.CONFIRMED,
      amountPaid: 0,
    });

    session.bookedCount += 1;
    await session.save();

    await notificationService.notify({
      userId: req.user._id,
      type: 'session_booking',
      title: 'Booking confirmed',
      message: `You're booked for "${session.title}" on ${new Date(session.scheduledAt).toLocaleString('en-IN')}.`,
      relatedModel: 'Session',
      relatedId: session._id,
    });

    return new ApiResponse(201, { booking, requiresPayment: false }, 'Booking confirmed').send(res);
  }

  // paid session — create a pending booking + Razorpay order
  const booking = await Booking.create({
    session: sessionId,
    user: req.user._id,
    status: BOOKING_STATUS.PENDING,
    amountPaid: session.price,
  });

  const order = await paymentService.createOrder(session.price, `booking_${booking._id}`, {
    bookingId: String(booking._id),
    sessionId: String(session._id),
  });

  return new ApiResponse(201, { booking, requiresPayment: true, order }, 'Complete payment to confirm booking').send(res);
});

/** POST /api/bookings/verify-payment — called by the frontend after Razorpay checkout succeeds */
const verifyBookingPayment = catchAsync(async (req, res) => {
  const { bookingId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

  const isValid = paymentService.verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature });
  if (!isValid) throw ApiError.badRequest('Payment verification failed');

  const booking = await Booking.findById(bookingId).populate({ path: 'session', populate: 'creator' });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (!booking.user.equals(req.user._id)) throw ApiError.forbidden('This booking does not belong to you');

  const { platformCommission, netAmount } = await walletService.splitEarnings(booking.amountPaid, booking.session.creator._id);

  const transaction = await Transaction.create({
    type: TRANSACTION_TYPE.SESSION_PAYMENT,
    status: TRANSACTION_STATUS.SUCCESS,
    from: req.user._id,
    to: booking.session.creator.user,
    amount: booking.amountPaid,
    platformCommission,
    netAmount,
    relatedModel: 'Booking',
    relatedId: booking._id,
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  });

  await walletService.creditCreator(booking.session.creator._id, netAmount);

  booking.status = BOOKING_STATUS.CONFIRMED;
  booking.transaction = transaction._id;
  await booking.save();

  booking.session.bookedCount += 1;
  await booking.session.save();

  await notificationService.notify({
    userId: req.user._id,
    type: 'payment_success',
    title: 'Payment successful',
    message: `Your booking for "${booking.session.title}" is confirmed.`,
    relatedModel: 'Session',
    relatedId: booking.session._id,
  });

  return new ApiResponse(200, { booking }, 'Payment verified, booking confirmed').send(res);
});

const getMyBookings = catchAsync(async (req, res) => {
  const bookings = await Booking.find({ user: req.user._id })
    .populate({ path: 'session', populate: { path: 'creator', populate: { path: 'user', select: 'name avatarUrl' } } })
    .sort({ createdAt: -1 });

  return new ApiResponse(200, bookings, 'Bookings fetched').send(res);
});

const cancelBooking = catchAsync(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw ApiError.notFound('Booking not found');
  if (!booking.user.equals(req.user._id)) throw ApiError.forbidden('This booking does not belong to you');

  booking.status = BOOKING_STATUS.CANCELLED;
  await booking.save();

  return new ApiResponse(200, null, 'Booking cancelled').send(res);
});

module.exports = { createBooking, verifyBookingPayment, getMyBookings, cancelBooking };
