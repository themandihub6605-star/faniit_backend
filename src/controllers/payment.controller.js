const paymentService = require('../services/payment.service');
const { Transaction } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

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
    default:
      // unhandled event types are safely ignored
      break;
  }

  // Razorpay expects a fast 200 response regardless of internal handling
  return new ApiResponse(200, null, 'Webhook processed').send(res);
});

const getMyTransactions = catchAsync(async (req, res) => {
  const transactions = await Transaction.find({ $or: [{ from: req.user._id }, { to: req.user._id }] }).sort({ createdAt: -1 });
  return new ApiResponse(200, transactions, 'Transactions fetched').send(res);
});

module.exports = { handleWebhook, getMyTransactions };
