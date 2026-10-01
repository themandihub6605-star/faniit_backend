const razorpay = require('../../config/razorpay');
const env = require('../../config/env');
const { User, Gift } = require('../../models');
const paymentService = require('../../services/payment.service');
const ApiError = require('../../utils/apiError');
const { Store, DigitalProduct, StoreOrder } = require('../models');
const { ORDER_STATUS, ORDER_ITEM, PRODUCT_STATUS, STORE_STATUS, PAY_WITH } = require('../constants');
const settingsService = require('./settings.service');
const earningsService = require('./earnings.service');
const invoiceService = require('./invoice.service');
const { safeNotify } = require('./notify.service');
const { formatRupees } = require('../utils/money');
const log = require('../utils/logger');

// One purchase flow for every store item (products, live tickets, calls):
//
//   startCheckout → StoreOrder(pending)
//        free item      → paid immediately
//        pay by wallet  → wallet debited → paid immediately
//        Razorpay       → Razorpay order; the app pays, then calls verify
//   markPaid      → pending→paid flipped atomically (exactly once)
//                 → invoice number → afterPaid() for that item type
//   refundOrder   → money back (Razorpay or wallet), seller reversed, access removed

const PENDING_REUSE_MS = 30 * 60 * 1000;

// ---------- helpers ----------

async function hasPaidAccess(buyerId, itemId) {
  return Boolean(await StoreOrder.exists({ buyer: buyerId, itemId, status: ORDER_STATUS.PAID }));
}

/** Takes money from the buyer's Fanitt wallet, only if they have enough. */
async function debitWallet(userId, amount) {
  const res = await User.updateOne({ _id: userId, walletBalance: { $gte: amount } }, { $inc: { walletBalance: -amount } });
  if (res.modifiedCount === 0) throw ApiError.badRequest('Not enough balance in your Fanitt wallet', [], 'INSUFFICIENT_WALLET');
  // The fee-exempt part can never be more than what's left.
  const user = await User.findById(userId).select('walletBalance walletFeeExempt');
  const cap = Math.max(0, user.walletBalance || 0);
  if ((user.walletFeeExempt || 0) > cap) await User.updateOne({ _id: userId }, { $set: { walletFeeExempt: cap } });
}

const NOTIFY_TEXT = {
  [ORDER_ITEM.DIGITAL_PRODUCT]: {
    buyerTitle: 'Purchase complete',
    buyer: (o) => `"${o.itemTitle}" is in your library now.`,
    seller: (o) => `Someone got "${o.itemTitle}".`,
  },
  [ORDER_ITEM.LIVE_STREAM]: {
    buyerTitle: 'Ticket confirmed',
    buyer: (o) => `You're in for "${o.itemTitle}". We'll remind you when it goes live.`,
    seller: (o) => `New ticket for "${o.itemTitle}".`,
  },
};

/** What happens once an order is paid, per item type. */
async function afterPaid(order) {
  if (order.itemType === ORDER_ITEM.CALL) {
    // Calls are billed by the minute when they end — nothing credited yet.
    // Lazy require: call.service also uses this module.
    const callService = require('./call.service');
    await callService.onCallPaid(order);
    return;
  }

  const settings = await settingsService.getSettings();

  if (order.itemType === ORDER_ITEM.FANBOX) {
    const credited = await earningsService.creditSale(order._id, { feePercent: settings.fanboxFeePercent });
    // Keep the existing Gift record so the old FanBox screens still list it.
    if (credited?.transaction) {
      await Gift.create({
        fromUser: order.buyer,
        toCreator: order.itemId,
        amount: order.amount,
        message: order.message || '',
        transaction: credited.transaction,
      });
    }
    await safeNotify({
      userId: order.seller,
      fromUser: order.buyer,
      type: 'gift_received',
      title: 'You received a FanBox! 🎁',
      message: `${formatRupees(credited?.creatorEarning ?? order.amount)} from a fan${order.message ? `: "${order.message}"` : '.'}`,
      relatedModel: 'StoreOrder',
      relatedId: order._id,
    });
    return;
  }

  await earningsService.creditSale(order._id, { feePercent: settings.storeFeePercent });

  const text = NOTIFY_TEXT[order.itemType];
  await Promise.all([
    safeNotify({
      userId: order.buyer,
      type: 'store_order',
      title: text.buyerTitle,
      message: text.buyer(order),
      relatedModel: 'StoreOrder',
      relatedId: order._id,
    }),
    safeNotify({
      userId: order.seller,
      type: 'store_sale',
      title: order.amount > 0 ? `New sale — ${formatRupees(order.amount)}` : 'New free sign-up',
      message: text.seller(order),
      relatedModel: 'StoreOrder',
      relatedId: order._id,
    }),
  ]);
}

async function markPaid(order, { razorpayPaymentId = '' } = {}) {
  // Only one request can move this order from pending to paid (MongoDB
  // guarantees a single-document findOneAndUpdate is atomic).
  const paid = await StoreOrder.findOneAndUpdate(
    { _id: order._id, status: ORDER_STATUS.PENDING },
    { $set: { status: ORDER_STATUS.PAID, razorpayPaymentId, paidAt: new Date() } },
    { new: true }
  );
  if (!paid) return null;

  // Invoice number only for the request that won, so numbers have no gaps.
  paid.invoiceNumber = await invoiceService.nextInvoiceNumber(paid.paidAt);
  await paid.save();
  log.info('order.paid', {
    orderId: String(paid._id),
    itemType: paid.itemType,
    amount: paid.amount,
    paidWith: paid.paidWith,
    invoiceNumber: paid.invoiceNumber,
    razorpayPaymentId,
  });

  await afterPaid(paid);
  return StoreOrder.findById(paid._id);
}

/**
 * Starts paying for one item.
 * spec: { store, seller?, itemType, itemId, itemTitle, itemCoverUrl, amount, description, reusePending, message?, context? }
 * Returns { order, paid, razorpay }.
 */
async function startCheckout(buyer, spec, { payWith = PAY_WITH.RAZORPAY } = {}) {
  const base = {
    buyer: buyer._id,
    store: spec.store?._id || null,
    seller: spec.seller || spec.store.user,
    message: spec.message || '',
    context: spec.context || '',
    itemType: spec.itemType,
    itemId: spec.itemId,
    itemTitle: spec.itemTitle,
    itemCoverUrl: spec.itemCoverUrl || '',
    amount: spec.amount,
  };

  if (spec.amount === 0) {
    const order = await StoreOrder.create({ ...base, paidWith: PAY_WITH.FREE });
    return { order: await markPaid(order), paid: true, razorpay: null };
  }

  if (payWith === PAY_WITH.WALLET) {
    const order = await StoreOrder.create({ ...base, paidWith: PAY_WITH.WALLET });
    try {
      await debitWallet(buyer._id, spec.amount);
    } catch (err) {
      order.status = ORDER_STATUS.FAILED;
      order.failureReason = err.message;
      await order.save();
      throw err;
    }
    log.info('order.wallet_debited', { orderId: String(order._id), amount: spec.amount });
    return { order: await markPaid(order), paid: true, razorpay: null };
  }

  // Reuse a recent unpaid attempt for the same item and price.
  let order = null;
  if (spec.reusePending) {
    order = await StoreOrder.findOne({
      buyer: buyer._id,
      itemId: spec.itemId,
      status: ORDER_STATUS.PENDING,
      paidWith: PAY_WITH.RAZORPAY,
      amount: spec.amount,
      razorpayOrderId: { $gt: '' },
      createdAt: { $gte: new Date(Date.now() - PENDING_REUSE_MS) },
    }).sort({ createdAt: -1 });
  }
  if (!order) {
    order = await StoreOrder.create({ ...base, paidWith: PAY_WITH.RAZORPAY });
    const rzp = await paymentService.createOrder(spec.amount, `store_${order._id}`, {
      storeOrderId: String(order._id),
      itemType: spec.itemType,
      itemId: String(spec.itemId),
      buyerId: String(buyer._id),
    });
    order.razorpayOrderId = rzp.id;
    await order.save();
    log.info('order.created', { orderId: String(order._id), itemType: spec.itemType, razorpayOrderId: rzp.id, amount: spec.amount });
  }

  return {
    order,
    paid: false,
    razorpay: {
      keyId: env.razorpay.keyId,
      orderId: order.razorpayOrderId,
      amount: order.amount,
      currency: 'INR',
      name: spec.store?.name || spec.sellerName || 'Fanitt',
      description: spec.description || spec.itemTitle,
      prefill: { name: buyer.name || '', email: buyer.email || '', contact: buyer.phone || '' },
    },
  };
}

// ---------- digital products ----------

async function checkoutProduct(buyer, productId, options) {
  const product = await DigitalProduct.findById(productId);
  if (!product || product.status !== PRODUCT_STATUS.PUBLISHED) throw ApiError.notFound('This product is not available');
  const store = await Store.findById(product.store);
  if (!store || store.status !== STORE_STATUS.ACTIVE || !store.isOpen) {
    throw ApiError.badRequest('This store is not taking orders right now');
  }
  if (String(store.user) === String(buyer._id)) throw ApiError.badRequest("You can't buy your own product");
  if (await hasPaidAccess(buyer._id, product._id)) {
    throw ApiError.conflict('You already own this — find it in your library', [], 'ALREADY_OWNED');
  }
  return startCheckout(
    buyer,
    {
      store,
      itemType: ORDER_ITEM.DIGITAL_PRODUCT,
      itemId: product._id,
      itemTitle: product.title,
      itemCoverUrl: product.coverUrl,
      amount: product.price,
      reusePending: true,
    },
    options
  );
}

// ---------- verify / refund ----------

/** Confirms a paid Razorpay checkout. Safe to call more than once. */
async function verifyPayment(buyerId, orderId, { razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const order = await StoreOrder.findById(orderId);
  if (!order || String(order.buyer) !== String(buyerId)) throw ApiError.notFound('Order not found');

  if (order.status === ORDER_STATUS.PAID) {
    if (order.razorpayPaymentId && order.razorpayPaymentId !== razorpayPaymentId) {
      throw ApiError.conflict('This order was already paid with a different payment');
    }
    return order;
  }
  if (order.status !== ORDER_STATUS.PENDING) throw ApiError.badRequest(`This order is ${order.status}`);
  if (order.paidWith !== PAY_WITH.RAZORPAY || order.razorpayOrderId !== razorpayOrderId) {
    throw ApiError.badRequest('Payment does not belong to this order');
  }

  if (!paymentService.verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature })) {
    log.warn('order.bad_signature', { orderId: String(order._id), razorpayOrderId });
    throw ApiError.badRequest('Payment verification failed');
  }

  // Ask Razorpay directly — never trust the app alone.
  const rzpOrder = await razorpay.orders.fetch(razorpayOrderId);
  if (!rzpOrder || rzpOrder.status !== 'paid' || Number(rzpOrder.amount_paid) !== order.amount) {
    log.warn('order.not_paid_on_razorpay', {
      orderId: String(order._id),
      razorpayStatus: rzpOrder?.status,
      amountPaid: rzpOrder?.amount_paid,
      expected: order.amount,
    });
    throw ApiError.badRequest('Payment is not complete yet — if money was deducted it will be confirmed shortly');
  }

  const paid = await markPaid(order, { razorpayPaymentId });
  return paid || StoreOrder.findById(order._id);
}

/**
 * Full refund of a paid product or live ticket: money back (Razorpay or
 * wallet — whichever paid), seller reversed, access removed. Calls settle
 * by the minute instead (see call.service).
 */
async function refundOrder(orderId, { byUserId, reason }) {
  const order = await StoreOrder.findById(orderId);
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status !== ORDER_STATUS.PAID) throw ApiError.badRequest('Only paid orders can be refunded');
  if (order.itemType === ORDER_ITEM.CALL) throw ApiError.badRequest('Call payments are settled automatically when the call ends');

  let refundId = '';
  if (order.amount > 0 && order.paidWith === PAY_WITH.RAZORPAY) {
    if (!order.razorpayPaymentId) throw ApiError.badRequest('This order has no payment to refund');
    try {
      const refund = await razorpay.payments.refund(order.razorpayPaymentId, {
        amount: order.amount,
        notes: { storeOrderId: String(order._id), reason: String(reason).slice(0, 200) },
      });
      refundId = refund?.id || '';
    } catch (err) {
      log.error('order.refund_gateway_failed', err, { orderId: String(order._id) });
      const detail = err?.error?.description || err?.message || 'Razorpay refused the refund';
      throw ApiError.badRequest(`Refund failed: ${detail}`);
    }
  }

  const updated = await StoreOrder.findOneAndUpdate(
    { _id: order._id, status: ORDER_STATUS.PAID },
    { $set: { status: ORDER_STATUS.REFUNDED, refundedAt: new Date(), refundReason: reason, refundedBy: byUserId, razorpayRefundId: refundId } },
    { new: true }
  );
  if (!updated) throw ApiError.conflict('This order was already refunded');

  if (updated.paidWith === PAY_WITH.WALLET && updated.amount > 0) {
    await earningsService.refundToWallet(updated, updated.amount, reason);
  }
  if (updated.creditedAt) await earningsService.reverseSale(updated, { byUserId, reason });

  const toWallet = updated.paidWith === PAY_WITH.WALLET;
  await Promise.all([
    safeNotify({
      userId: updated.buyer,
      type: 'store_order',
      title: 'Refund issued',
      message: toWallet
        ? `${formatRupees(updated.amount)} for "${updated.itemTitle}" is back in your Fanitt wallet.`
        : `Your payment for "${updated.itemTitle}" was refunded. It reaches your account in 5–7 working days.`,
      relatedModel: 'StoreOrder',
      relatedId: updated._id,
    }),
    safeNotify({
      userId: updated.seller,
      type: 'store_sale',
      title: 'An order was refunded',
      message: `"${updated.itemTitle}" was refunded: ${reason}`,
      relatedModel: 'StoreOrder',
      relatedId: updated._id,
    }),
  ]);
  log.info('order.refunded', { orderId: String(updated._id), refundId, toWallet, byUserId: String(byUserId || '') });
  return updated;
}

module.exports = { startCheckout, checkoutProduct, verifyPayment, refundOrder, hasPaidAccess, markPaid };
