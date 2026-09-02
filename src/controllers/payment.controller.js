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
      let sub = await UserSubscription.findOne({ razorpaySubscriptionId: rzpSubId }).populate('plan');

      if (!sub) {
        // BUG FIX: the client-side verifyCheckout call never ran for this
        // subscription (tab closed / network dropped / app crashed right
        // after Razorpay checkout succeeded) — so no UserSubscription row
        // was ever linked to this razorpaySubscriptionId. Previously this
        // branch just fell through and did nothing, silently leaving the
        // user's plan un-upgraded forever even though Razorpay had
        // charged them successfully. Recover using the userId/planId we
        // set as `notes` when the subscription was created (see
        // subscription.controller.js's createCheckout) — this webhook is
        // the only remaining place that knows this payment happened, so
        // it has to be able to create/link the subscription itself.
        const { userId, planId } = payload.subscription.entity.notes || {};

        if (!userId || !planId) {
          // Nothing to recover from — no existing link and no notes to
          // fall back to. Log loudly for manual reconciliation rather
          // than silently dropping a real payment on the floor.
          console.error(
            `[webhook] subscription.charged for unknown subscription ${rzpSubId} with no notes to recover from — manual reconciliation needed`
          );
          break;
        }

        sub = await UserSubscription.findOne({ user: userId });
        if (!sub) {
          sub = new UserSubscription({ user: userId });
        }
        sub.plan = planId;
        sub.razorpaySubscriptionId = rzpSubId;
        sub.cancelAtPeriodEnd = false;
        sub = await sub.populate('plan');
      }

      sub.status = SUBSCRIPTION_STATUS.ACTIVE;
      sub.currentPeriodStart = new Date();
      sub.currentPeriodEnd = subscriptionService.addCycle(new Date(), sub.plan.billingCycle);
      sub.proposalsUsedThisCycle = 0;
      sub.campaignsPostedThisCycle = 0;
      await sub.save();
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