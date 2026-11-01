// File: src/controllers/booking.controller.js
const { Booking, Session, Transaction, User, CreatorProfile } = require('../models');
const paymentService = require('../services/payment.service');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');
const { sendSessionBookingConfirmationEmail, sendSessionCancelledEmail } = require('../services/email.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { BOOKING_STATUS, TRANSACTION_TYPE, TRANSACTION_STATUS, SESSION_TYPES } = require('../constants/enums');

const meetRoom = () => require('../FanittStore/services/meetRoom.service');

// Bookable until the meeting can no longer start: planned end + 1 h grace.
const GRACE_MS = 60 * 60 * 1000;
const endsAtMs = (s) => new Date(s.scheduledAt).getTime() + (s.durationMinutes || 60) * 60 * 1000;
const istText = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

const populateHost = { path: 'creator', populate: { path: 'user', select: 'name' } };

/** Takes one seat if there is one left. Returns false when full. */
async function takeSeat(sessionId) {
  const res = await Session.updateOne(
    { _id: sessionId, $expr: { $lt: ['$bookedCount', '$maxParticipants'] } },
    { $inc: { bookedCount: 1 } }
  ).catch(() => null);
  if (res) return res.modifiedCount === 1;
  // Fallback for databases without $expr: read then increment.
  const s = await Session.findById(sessionId).select('bookedCount maxParticipants');
  if (!s || s.bookedCount >= s.maxParticipants) return false;
  await Session.updateOne({ _id: sessionId }, { $inc: { bookedCount: 1 } });
  return true;
}

/** POST /api/bookings — book a session. Free sessions confirm instantly; paid sessions return a Razorpay order to pay. */
const createBooking = catchAsync(async (req, res) => {
  const { sessionId } = req.body;

  const session = await Session.findById(sessionId).populate(populateHost);
  if (!session) throw ApiError.notFound('Session not found');
  if (session.isCancelled) throw ApiError.badRequest('This session has been cancelled');
  if (session.isCompleted || Date.now() > endsAtMs(session) + GRACE_MS) throw ApiError.badRequest('This session is already over');
  if (String(session.creator?.user?._id || '') === String(req.user._id)) throw ApiError.badRequest('This is your own session — you host it');
  if (session.bookedCount >= session.maxParticipants) throw ApiError.badRequest('This session is fully booked');

  // One booking per person per session. A cancelled one, or a paid one that
  // was never paid, is reused so they can book again.
  let booking = await Booking.findOne({ session: sessionId, user: req.user._id });
  if (booking && [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED].includes(booking.status)) {
    throw ApiError.conflict('You have already booked this session');
  }

  if (session.type === SESSION_TYPES.FREE) {
    if (!(await takeSeat(session._id))) throw ApiError.badRequest('This session is fully booked');

    if (booking) {
      booking.status = BOOKING_STATUS.CONFIRMED;
      booking.amountPaid = 0;
      booking.transaction = null;
      await booking.save();
    } else {
      booking = await Booking.create({ session: sessionId, user: req.user._id, status: BOOKING_STATUS.CONFIRMED, amountPaid: 0 });
    }

    await notificationService
      .notify({
        userId: req.user._id,
        type: 'session_booking',
        title: 'Booking confirmed',
        message: `You're booked for "${session.title}" on ${istText(session.scheduledAt)}.`,
        relatedModel: 'Session',
        relatedId: session._id,
      })
      .catch(() => {});

    // The host hears about it: "Rahul booked your session".
    meetRoom().notifyHostBooked(session, req.user);

    if (req.user.email) {
      sendSessionBookingConfirmationEmail({
        to: req.user.email,
        name: req.user.name,
        sessionTitle: session.title,
        scheduledAt: session.scheduledAt,
        otherPartyName: session.creator?.user?.name || 'the creator',
      });
    }

    return new ApiResponse(201, { booking, requiresPayment: false }, 'Booking confirmed').send(res);
  }

  // paid session — a pending booking + Razorpay order (seat is taken on payment)
  if (booking) {
    booking.status = BOOKING_STATUS.PENDING;
    booking.amountPaid = session.price;
    booking.transaction = null;
    await booking.save();
  } else {
    booking = await Booking.create({ session: sessionId, user: req.user._id, status: BOOKING_STATUS.PENDING, amountPaid: session.price });
  }

  const order = await paymentService.createOrder(session.price, `booking_${booking._id}`, {
    bookingId: String(booking._id),
    sessionId: String(session._id),
  });

  return new ApiResponse(201, { booking, requiresPayment: true, order }, 'Complete payment to confirm booking').send(res);
});

/** POST /api/bookings/verify-payment — called by the app after Razorpay checkout succeeds */
const verifyBookingPayment = catchAsync(async (req, res) => {
  const { bookingId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

  const isValid = paymentService.verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature });
  if (!isValid) throw ApiError.badRequest('Payment verification failed');

  const booking = await Booking.findById(bookingId).populate({ path: 'session', populate: populateHost });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (!booking.user.equals(req.user._id)) throw ApiError.forbidden('This booking does not belong to you');
  if (booking.status !== BOOKING_STATUS.PENDING) throw ApiError.conflict('This booking is already confirmed');

  const order = await paymentService.claimOrder({ razorpayOrderId, razorpayPaymentId });
  if (order.amount !== booking.amountPaid) throw ApiError.badRequest('Payment amount does not match this booking');

  const { platformCommission, agencyCommission, referralCommission, netAmount } = await walletService.splitEarnings(
    booking.amountPaid,
    booking.session.creator._id,
    'Booking',
    booking._id
  );

  const transaction = await Transaction.create({
    type: TRANSACTION_TYPE.SESSION_PAYMENT,
    status: TRANSACTION_STATUS.SUCCESS,
    from: req.user._id,
    to: booking.session.creator.user,
    amount: booking.amountPaid,
    platformCommission,
    agencyCommission,
    referralCommission,
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

  // Paid already — always count the seat.
  await Session.updateOne({ _id: booking.session._id }, { $inc: { bookedCount: 1 } });

  await notificationService
    .notify({
      userId: req.user._id,
      type: 'payment_success',
      title: 'Payment successful',
      message: `Your booking for "${booking.session.title}" on ${istText(booking.session.scheduledAt)} is confirmed.`,
      relatedModel: 'Session',
      relatedId: booking.session._id,
    })
    .catch(() => {});

  meetRoom().notifyHostBooked(booking.session, req.user, { paid: netAmount });

  if (req.user.email) {
    sendSessionBookingConfirmationEmail({
      to: req.user.email,
      name: req.user.name,
      sessionTitle: booking.session.title,
      scheduledAt: booking.session.scheduledAt,
      otherPartyName: booking.session.creator?.user?.name || 'the creator',
    });
  }

  return new ApiResponse(200, { booking }, 'Payment verified, booking confirmed').send(res);
});

const getMyBookings = catchAsync(async (req, res) => {
  const bookings = await Booking.find({ user: req.user._id })
    .populate({ path: 'session', populate: { path: 'creator', populate: { path: 'user', select: 'name avatarUrl' } } })
    .sort({ createdAt: -1 });

  return new ApiResponse(200, bookings, 'Bookings fetched').send(res);
});

const cancelBooking = catchAsync(async (req, res) => {
  const booking = await Booking.findById(req.params.id).populate({ path: 'session', populate: populateHost });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (!booking.user.equals(req.user._id)) throw ApiError.forbidden('This booking does not belong to you');
  if (booking.status === BOOKING_STATUS.CANCELLED) return new ApiResponse(200, null, 'Booking cancelled').send(res);
  if (booking.session && (booking.session.isLive || booking.session.isCompleted)) {
    throw ApiError.badRequest('This session has already started');
  }

  const wasConfirmed = booking.status === BOOKING_STATUS.CONFIRMED;
  booking.status = BOOKING_STATUS.CANCELLED;
  await booking.save();

  // Free the seat.
  if (wasConfirmed && booking.session) {
    await Session.updateOne({ _id: booking.session._id, bookedCount: { $gt: 0 } }, { $inc: { bookedCount: -1 } });
  }

  if (wasConfirmed && req.user.email && booking.session) {
    sendSessionCancelledEmail({
      to: req.user.email,
      name: req.user.name,
      sessionTitle: booking.session.title,
      scheduledAt: booking.session.scheduledAt,
      otherPartyName: booking.session.creator?.user?.name || 'the creator',
    });
  }

  return new ApiResponse(200, null, 'Booking cancelled').send(res);
});

// After a reschedule, booked fans have this long to say "I won't join".
const DECLINE_WINDOW_MS = 30 * 60 * 1000;
const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/**
 * PATCH /api/bookings/:id/decline  { message }
 * "I won't join" — only within 30 minutes of the host rescheduling.
 * Frees the seat, refunds a paid booking to the fan's Fanitt wallet (taken
 * back from the host's wallet) and sends the fan's message to the host.
 */
const declineBooking = catchAsync(async (req, res) => {
  const message = String(req.body?.message || '').trim().slice(0, 300);
  const booking = await Booking.findById(req.params.id).populate({ path: 'session', populate: populateHost });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (!booking.user.equals(req.user._id)) throw ApiError.forbidden('This booking does not belong to you');
  const session = booking.session;
  if (!session) throw ApiError.notFound('This session no longer exists');
  if (booking.declinedAt) throw ApiError.conflict('You already told the host you can’t join');
  if (booking.status !== BOOKING_STATUS.CONFIRMED) throw ApiError.badRequest('This booking is not active');
  if (session.isCancelled || session.isLive || session.isCompleted) throw ApiError.badRequest('This session can’t be changed now');
  const movedAt = session.rescheduledAt ? new Date(session.rescheduledAt).getTime() : 0;
  if (!movedAt || Date.now() > movedAt + DECLINE_WINDOW_MS) {
    throw ApiError.badRequest('The 30 minutes to opt out after the time change have passed');
  }

  // Claim it once (double taps / two phones).
  const claimed = await Booking.findOneAndUpdate(
    { _id: booking._id, status: BOOKING_STATUS.CONFIRMED, declinedAt: null },
    { $set: { status: BOOKING_STATUS.CANCELLED, declinedAt: new Date(), declineMessage: message } },
    { new: true }
  );
  if (!claimed) throw ApiError.conflict('You already told the host you can’t join');

  await Session.updateOne({ _id: session._id, bookedCount: { $gt: 0 } }, { $inc: { bookedCount: -1 } });

  const hostUserId = session.creator?.user?._id || session.creator?.user;
  let refunded = 0;
  if (booking.amountPaid > 0 && booking.transaction) {
    const paid = await Transaction.findById(booking.transaction).select('amount netAmount').lean();
    const amount = paid?.amount || booking.amountPaid;
    const hostShare = paid ? paid.netAmount || 0 : amount;

    // Fan's own money back → no withdrawal fee on it.
    await User.updateOne({ _id: req.user._id }, { $inc: { walletBalance: amount, walletFeeExempt: amount } });
    if (hostShare > 0 && hostUserId) {
      await User.updateOne({ _id: hostUserId }, { $inc: { walletBalance: -hostShare } });
      await CreatorProfile.updateOne({ _id: session.creator._id }, { $inc: { totalEarnings: -hostShare, thisMonthEarnings: -hostShare } });
    }
    await Transaction.create({
      type: TRANSACTION_TYPE.REFUND,
      status: TRANSACTION_STATUS.SUCCESS,
      from: hostUserId || null,
      to: req.user._id,
      amount,
      netAmount: amount,
      relatedModel: 'Booking',
      relatedId: booking._id,
      notes: `Session refund: "${session.title}" — can't join the new time`.slice(0, 500),
    });
    await Booking.updateOne({ _id: booking._id }, { $set: { refundedAt: new Date(), refundAmount: amount } });
    refunded = amount;
  }

  // Host: who can't come and why.
  if (hostUserId) {
    notificationService
      .notify({
        userId: hostUserId,
        fromUser: req.user._id,
        type: 'session_booking',
        title: `${req.user.name || 'Someone'} can’t join "${session.title}"`,
        message: `${message ? `“${message}”` : 'They can’t make the new time.'}${refunded ? ` · ${rupees(refunded)} refunded to their wallet` : ''}`,
        relatedModel: 'Session',
        relatedId: session._id,
      })
      .catch(() => {});
  }
  // Fan: confirmation.
  notificationService
    .notify({
      userId: req.user._id,
      type: 'session_booking',
      title: refunded ? 'Refund added to your wallet' : 'Host informed',
      message: refunded
        ? `${rupees(refunded)} for "${session.title}" is back in your Fanitt wallet.`
        : `We told the host you can’t join "${session.title}".`,
      relatedModel: 'Session',
      relatedId: session._id,
    })
    .catch(() => {});

  return new ApiResponse(200, { declined: true, refunded }, refunded ? `${rupees(refunded)} refunded to your wallet` : 'The host has been told').send(res);
});

module.exports = { createBooking, verifyBookingPayment, getMyBookings, cancelBooking, declineBooking, DECLINE_WINDOW_MS };