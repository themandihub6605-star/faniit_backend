const { User, Transaction, CreatorProfile } = require('../../models');
const walletService = require('../../services/wallet.service');
const { TRANSACTION_TYPE, TRANSACTION_STATUS } = require('../../constants/enums');
const { Store, StoreOrder, DigitalProduct, LiveStream } = require('../models');
const { ORDER_ITEM } = require('../constants');
const { percentOf } = require('../utils/money');
const log = require('../utils/logger');

// Moves money for store sales in and out of the ONE existing Fanitt wallet.
//
// Split of a charged amount:
//   store fee (settings.storeFeePercent)  → Fanitt
//   agency / referral commission          → existing wallet.service rules
//   the rest                              → seller's walletBalance
//
// The fee is taken here, at sale time, so the credited amount is also added
// to `walletFeeExempt` — withdrawals don't charge a second fee on it.

async function bumpItemStats(order, sign, gross) {
  if (order.itemType === ORDER_ITEM.DIGITAL_PRODUCT) {
    const filter = sign < 0 ? { _id: order.itemId, salesCount: { $gt: 0 } } : { _id: order.itemId };
    await DigitalProduct.updateOne(filter, { $inc: { salesCount: sign, revenue: sign * gross } });
  } else if (order.itemType === ORDER_ITEM.LIVE_STREAM) {
    const filter = sign < 0 ? { _id: order.itemId, 'stats.ticketsSold': { $gt: 0 } } : { _id: order.itemId };
    await LiveStream.updateOne(filter, { $inc: { 'stats.ticketsSold': sign, 'stats.revenue': sign * gross } });
  }
}

/**
 * Credits the seller for a paid order, exactly once.
 * `grossAmount` defaults to the full order amount; calls pass the billed
 * part only (the rest is refunded to the buyer by the caller).
 */
async function creditSale(orderId, { feePercent, grossAmount = null }) {
  const order = await StoreOrder.findOneAndUpdate(
    { _id: orderId, status: 'paid', creditedAt: null },
    { $set: { creditedAt: new Date() } },
    { new: true }
  );
  if (!order) {
    log.warn('earnings.credit_skipped', { orderId: String(orderId), reason: 'already credited or not paid' });
    return null;
  }

  const gross = grossAmount == null ? order.amount : Math.max(0, Math.min(grossAmount, order.amount));
  try {
    // FanBox tips can reach creators without a store, so find the creator
    // profile from the store when there is one, otherwise from the seller.
    const store = order.store ? await Store.findById(order.store).select('creator user') : null;
    const creatorProfileId = store ? store.creator : (await CreatorProfile.findOne({ user: order.seller }).select('_id'))?._id;
    if (!creatorProfileId) throw new Error('Creator profile not found for this seller');
    const feeAmount = percentOf(gross, feePercent);
    const afterFee = gross - feeAmount;

    let agencyCommission = 0;
    let referralCommission = 0;
    let creatorEarning = afterFee;
    if (afterFee > 0) {
      const split = await walletService.splitEarnings(afterFee, creatorProfileId, 'StoreOrder', order._id);
      agencyCommission = split.agencyCommission;
      referralCommission = split.referralCommission;
      creatorEarning = split.netAmount;
      await walletService.creditCreator(creatorProfileId, creatorEarning);
      await User.updateOne({ _id: order.seller }, { $inc: { walletFeeExempt: creatorEarning } });
    }

    let transaction = null;
    if (gross > 0) {
      transaction = await Transaction.create({
        type: TRANSACTION_TYPE.STORE_SALE,
        status: TRANSACTION_STATUS.SUCCESS,
        from: order.buyer,
        to: order.seller,
        amount: gross,
        platformCommission: feeAmount,
        agencyCommission,
        referralCommission,
        netAmount: creatorEarning,
        relatedModel: 'StoreOrder',
        relatedId: order._id,
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: order.razorpayPaymentId,
        notes: `Store sale: ${order.itemTitle}`.slice(0, 500),
      });
    }

    order.feePercent = feePercent;
    order.feeAmount = feeAmount;
    order.agencyCommission = agencyCommission;
    order.referralCommission = referralCommission;
    order.creatorEarning = creatorEarning;
    order.settledAmount = gross;
    order.transaction = transaction?._id || null;
    await order.save();

    if (order.store) {
      await Store.updateOne(
        { _id: order.store },
        { $inc: { 'stats.orders': 1, 'stats.grossSales': gross, 'stats.feesPaid': feeAmount, 'stats.netEarnings': creatorEarning } }
      );
    }
    await bumpItemStats(order, 1, gross);

    log.info('earnings.credited', { orderId: String(order._id), gross, feeAmount, agencyCommission, referralCommission, creatorEarning });
    return order;
  } catch (err) {
    // The order stays paid and marked credited — this line has every id
    // needed to finish the credit by hand.
    log.error('earnings.credit_failed', err, { orderId: String(order._id), sellerId: String(order.seller), gross });
    throw err;
  }
}

/** Puts money back in a buyer's wallet (unused call minutes, wallet-paid refunds). */
async function refundToWallet(order, amount, reason) {
  if (!(amount > 0)) return 0;
  // It's the buyer's own money, so withdrawing it later has no fee either.
  await User.updateOne({ _id: order.buyer }, { $inc: { walletBalance: amount, walletFeeExempt: amount } });
  await Transaction.create({
    type: TRANSACTION_TYPE.REFUND,
    status: TRANSACTION_STATUS.SUCCESS,
    from: null,
    to: order.buyer,
    amount,
    netAmount: amount,
    relatedModel: 'StoreOrder',
    relatedId: order._id,
    notes: `Returned to wallet: ${reason}`.slice(0, 500),
  });
  await StoreOrder.updateOne({ _id: order._id }, { $inc: { walletRefund: amount } });
  log.info('earnings.wallet_refund', { orderId: String(order._id), amount, reason });
  return amount;
}

/** Takes a refunded sale back out of the seller's wallet. The balance may
 * go below zero; it's settled from their next earnings. */
async function reverseSale(order, { byUserId, reason }) {
  const amount = order.creatorEarning || 0;
  if (amount > 0) {
    await User.updateOne({ _id: order.seller }, { $inc: { walletBalance: -amount } });
    // Lower the fee-exempt part too, but never below zero.
    const reduced = await User.updateOne({ _id: order.seller, walletFeeExempt: { $gte: amount } }, { $inc: { walletFeeExempt: -amount } });
    if (reduced.modifiedCount === 0) await User.updateOne({ _id: order.seller }, { $set: { walletFeeExempt: 0 } });
  }

  await Transaction.create({
    type: TRANSACTION_TYPE.REFUND,
    status: TRANSACTION_STATUS.SUCCESS,
    from: order.seller,
    to: order.buyer,
    amount: order.amount,
    netAmount: order.amount,
    relatedModel: 'StoreOrder',
    relatedId: order._id,
    razorpayPaymentId: order.razorpayPaymentId,
    notes: `Store refund: ${reason}`.slice(0, 500),
  });

  const gross = order.settledAmount == null ? order.amount : order.settledAmount;
  if (order.store) await Store.updateOne({ _id: order.store }, { $inc: { 'stats.refunds': order.amount, 'stats.netEarnings': -amount } });
  await bumpItemStats(order, -1, gross);
  log.info('earnings.reversed', { orderId: String(order._id), amount, byUserId: String(byUserId || '') });
}

module.exports = { creditSale, refundToWallet, reverseSale };
