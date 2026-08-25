const paymentService = require('../services/payment.service');
const { Transaction, UserSubscription } = require('../models');
const subscriptionService = require('../services/subscription.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { SUBSCRIPTION_STATUS } = require('../constants/enums');

/**
 * POST /api/payments/webhook — Razorpay calls this directly (not the browser).
 * This is the source of truth for payment status; the client-side
 * verify-payment endpoints give the user instant feedback, but this webhook
 * is what we'd reconcile against if anything ever gets out of sync.
 */
const handleWebhook = catchAsync(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const isValid = paymentService.verifyWebhookSignature(req.rawBody, signature);

  if (!isValid) throw ApiError.unauthorized('Invalid webhook signature');

  const event = req.body.event;
  const payload = req.body.payload;

  switch (event) {
    case 'payment.captured': {
      const paymentId = payload.payment.entity.id;
      await Transaction.findOneAndUpdate({ razorpayPaymentId: paymentId }, { status: 'success' });
      break;
    }
    case 'payment.failed': {
      const orderId = payload.payment.entity.order_id;
      await Transaction.findOneAndUpdate({ razorpayOrderId: orderId }, { status: 'failed', failureReason: payload.payment.entity.error_description || 'Payment failed' });
      break;
    }

    // --- Subscription lifecycle events ---
    case 'subscription.charged': {
      // Fires on every successful renewal (including the first payment).
      // This is the authoritative moment to roll the billing period
      // forward and reset that period's usage counters.
      const rzpSubId = payload.subscription.entity.id;
      const sub = await UserSubscription.findOne({ razorpaySubscriptionId: rzpSubId }).populate('plan');
      if (sub) {
        sub.status = SUBSCRIPTION_STATUS.ACTIVE;
        sub.currentPeriodStart = new Date();
        sub.currentPeriodEnd = subscriptionService.addCycle(new Date(), sub.plan.billingCycle);
        sub.proposalsUsedThisCycle = 0;
        sub.campaignsPostedThisCycle = 0;
        await sub.save();
      }
      break;
    }
    case 'subscription.halted': {
      // Razorpay gave up retrying a failed renewal payment — mark past-due;
      // the user drops back to their role's default plan the next time
      // getOrCreateActiveSubscription notices the period has expired.
      const rzpSubId = payload.subscription.entity.id;
      await UserSubscription.findOneAndUpdate({ razorpaySubscriptionId: rzpSubId }, { status: SUBSCRIPTION_STATUS.PAST_DUE });
      break;
    }
    case 'subscription.cancelled':
    case 'subscription.completed': {
      const rzpSubId = payload.subscription.entity.id;
      await UserSubscription.findOneAndUpdate({ razorpaySubscriptionId: rzpSubId }, { status: SUBSCRIPTION_STATUS.CANCELLED });
      break;
    }

    default:
      // unhandled event types are safely ignored
      break;
  }

  return new ApiResponse(200, null, 'Webhook processed').send(res);
});

const getMyTransactions = catchAsync(async (req, res) => {
  const transactions = await Transaction.find({ $or: [{ from: req.user._id }, { to: req.user._id }] }).sort({ createdAt: -1 });
  return new ApiResponse(200, transactions, 'Transactions fetched').send(res);
});

module.exports = { handleWebhook, getMyTransactions };