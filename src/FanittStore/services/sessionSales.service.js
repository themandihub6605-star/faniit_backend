// File: src/FanittStore/services/sessionSales.service.js
const { Transaction, Booking, Session, User } = require('../../models');
const { TRANSACTION_TYPE, TRANSACTION_STATUS } = require('../../constants/enums');

// Live session (Virtual Meet) bookings are paid through the older booking
// flow, so they are not StoreOrders. This turns them into order-shaped rows
// so the store dashboard, Sales & orders and Analytics count them too —
// all of a creator's earnings in one place.
//
// Source of truth: the SESSION_PAYMENT transaction written when the booking
// was paid (amount + what the creator actually got). A booking refunded later
// (e.g. the fan said "I won't join" after a reschedule) shows as refunded and
// is left out of totals.

const SESSION_ITEM = 'session';

/**
 * Paid session bookings for a seller, newest first, shaped like StoreOrders.
 * @param {ObjectId|string} sellerId  the creator's user id
 * @param {{ from?: Date, limit?: number, withBuyer?: boolean, includeRefunded?: boolean }} opts
 */
async function sessionOrders(sellerId, { from = null, limit = 0, withBuyer = false, includeRefunded = false } = {}) {
  const filter = { type: TRANSACTION_TYPE.SESSION_PAYMENT, status: TRANSACTION_STATUS.SUCCESS, to: sellerId, relatedModel: 'Booking' };
  if (from) filter.createdAt = { $gte: from };
  let query = Transaction.find(filter).sort({ createdAt: -1 }).select('amount netAmount relatedId createdAt from');
  if (limit > 0) query = query.limit(limit);
  const txs = await query.lean();
  if (!txs.length) return [];

  const bookings = await Booking.find({ _id: { $in: txs.map((t) => t.relatedId) } }).select('session refundedAt').lean();
  const bookingById = new Map(bookings.map((b) => [String(b._id), b]));
  const sessionIds = [...new Set(bookings.map((b) => String(b.session)))];
  const sessions = sessionIds.length ? await Session.find({ _id: { $in: sessionIds } }).select('title coverImageUrl').lean() : [];
  const sessionById = new Map(sessions.map((s) => [String(s._id), s]));
  const buyers = withBuyer ? await User.find({ _id: { $in: txs.map((t) => t.from).filter(Boolean) } }).select('name avatarUrl').lean() : [];
  const buyerById = new Map(buyers.map((u) => [String(u._id), u]));

  const rows = txs.map((t) => {
    const booking = bookingById.get(String(t.relatedId));
    const session = booking ? sessionById.get(String(booking.session)) : null;
    const refunded = Boolean(booking?.refundedAt);
    return {
      _id: t.relatedId,
      itemType: SESSION_ITEM,
      itemId: session?._id || booking?.session || null,
      itemTitle: session?.title || 'Live session',
      itemCoverUrl: session?.coverImageUrl || '',
      amount: t.amount || 0,
      settledAmount: t.amount || 0,
      paidWith: 'razorpay',
      feePercent: 0,
      feeAmount: 0,
      creatorEarning: t.netAmount || 0,
      status: refunded ? 'refunded' : 'paid',
      invoiceNumber: '',
      paidAt: t.createdAt,
      refundedAt: booking?.refundedAt || null,
      createdAt: t.createdAt,
      buyer: withBuyer ? buyerById.get(String(t.from)) || null : t.from,
    };
  });
  return includeRefunded ? rows : rows.filter((r) => r.status === 'paid');
}

/** All-time totals of paid (not refunded) session bookings. */
async function sessionTotals(sellerId) {
  const rows = await sessionOrders(sellerId);
  return rows.reduce(
    (acc, r) => ({ orders: acc.orders + 1, gross: acc.gross + r.amount, net: acc.net + r.creatorEarning }),
    { orders: 0, gross: 0, net: 0 }
  );
}

/** Store stats with session bookings added (orders, gross sales, earnings). */
async function statsWithSessions(store, sellerId) {
  const base = store?.stats ? (typeof store.stats.toObject === 'function' ? store.stats.toObject() : { ...store.stats }) : {};
  const t = await sessionTotals(sellerId);
  return {
    ...base,
    orders: (base.orders || 0) + t.orders,
    grossSales: (base.grossSales || 0) + t.gross,
    netEarnings: (base.netEarnings || 0) + t.net,
  };
}

module.exports = { SESSION_ITEM, sessionOrders, sessionTotals, statsWithSessions };