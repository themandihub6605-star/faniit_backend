const crypto = require('crypto');
const razorpay = require('../config/razorpay');
const env = require('../config/env');
const ApiError = require('../utils/apiError');

/**
 * Creates a Razorpay order. Amount must already be in paise.
 * `receipt` should be a short unique string (e.g. `booking_<id>`).
 */
async function createOrder(amount, receipt, notes = {}) {
  if (amount <= 0) throw ApiError.badRequest('Amount must be greater than zero');

  const order = await razorpay.orders.create({
    amount,
    currency: 'INR',
    receipt,
    notes,
  });

  return order;
}

/**
 * Verifies the signature Razorpay sends back after a successful checkout,
 * using HMAC SHA256 with the key secret. This MUST pass before we ever
 * mark a booking/escrow as paid.
 */
function verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const expectedSignature = crypto
    .createHmac('sha256', env.razorpay.keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  return expectedSignature === razorpaySignature;
}

/** Razorpay's subscription-checkout signature uses a different concatenation
 * order than order-based checkout: `paymentId|subscriptionId` instead of
 * `orderId|paymentId`. */
function verifySubscriptionSignature({ razorpaySubscriptionId, razorpayPaymentId, razorpaySignature }) {
  const expectedSignature = crypto
    .createHmac('sha256', env.razorpay.keySecret)
    .update(`${razorpayPaymentId}|${razorpaySubscriptionId}`)
    .digest('hex');

  return expectedSignature === razorpaySignature;
}

/** Verifies the signature on incoming Razorpay webhook payloads. */
function verifyWebhookSignature(rawBody, signature) {
  const expectedSignature = crypto
    .createHmac('sha256', env.razorpay.webhookSecret)
    .update(rawBody)
    .digest('hex');

  return expectedSignature === signature;
}

/**
 * Pays out to a creator/agency's linked bank account or UPI via Razorpay
 * Payouts (RazorpayX). Requires the recipient to have a `fund_account_id`
 * on file — in this scaffold that's assumed to be stored on the User/
 * CreatorProfile once bank-details KYC is implemented.
 */
async function createPayout(fundAccountId, amount, referenceId) {
  // NOTE: RazorpayX Payouts require a separate account_number (your business
  // account) and are billed separately from standard Razorpay checkout.
  // This is the integration point — wire up `razorpayX.payouts.create(...)`
  // here once the business RazorpayX account is provisioned.
  return {
    id: `payout_stub_${referenceId}`,
    amount,
    fundAccountId,
    status: 'processing',
  };
}

/**
 * Replay guard for every verify endpoint. A valid signature only proves the
 * payment happened — not that it hasn't already been credited, or that the
 * client-sent amount is real. This rejects reused order/payment ids and
 * returns the order as Razorpay recorded it (use its `amount`).
 */
async function claimOrder({ razorpayOrderId, razorpayPaymentId }) {
  const { Transaction } = require('../models');
  const used = await Transaction.exists({
    $or: [{ razorpayPaymentId }, { razorpayOrderId }],
  });
  if (used) throw ApiError.conflict('This payment has already been processed');

  const order = await razorpay.orders.fetch(razorpayOrderId);
  if (!order || order.status === 'created') {
    throw ApiError.badRequest('This payment has not been completed');
  }
  return order;
}

module.exports = {
  claimOrder,
  createOrder,
  verifyPaymentSignature,
  verifySubscriptionSignature,
  verifyWebhookSignature,
  createPayout,
};