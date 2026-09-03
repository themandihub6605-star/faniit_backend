const razorpay = require('../config/razorpay');
const { SubscriptionPlan, UserSubscription, Transaction } = require('../models');
const paymentService = require('../services/payment.service');
const subscriptionService = require('../services/subscription.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { ROLES, TRANSACTION_TYPE, TRANSACTION_STATUS, SUBSCRIPTION_STATUS } = require('../constants/enums');

// GET /api/subscriptions/plans?appliesTo=creator|brand — public, for the pricing page
const listPlans = catchAsync(async (req, res) => {
  const { appliesTo } = req.query;
  const filter = { isActive: true };
  if (appliesTo) filter.appliesTo = appliesTo;

  const plans = await SubscriptionPlan.find(filter).sort({ appliesTo: 1, sortOrder: 1, price: 1 });
  return new ApiResponse(200, plans, 'Plans fetched').send(res);
});

// GET /api/subscriptions/me
const getMySubscription = catchAsync(async (req, res) => {
  const appliesTo = req.user.role === ROLES.BRAND ? 'brand' : 'creator';
  const sub = await subscriptionService.getOrCreateActiveSubscription(req.user._id, appliesTo);
  return new ApiResponse(200, sub, 'Subscription fetched').send(res);
});

// POST /api/subscriptions/checkout  { planId }
// Creates a Razorpay Subscription and returns its id — the frontend opens
// Razorpay Checkout in subscription mode with this id (a different flow
// from the one-time `orders.create` used elsewhere in the app).
const createCheckout = catchAsync(async (req, res) => {
  const { planId } = req.body;
  if (!planId) throw ApiError.badRequest('planId is required');

  const plan = await SubscriptionPlan.findById(planId);
  if (!plan || !plan.isActive) throw ApiError.notFound('Plan not found');

  const expectedAppliesTo = req.user.role === ROLES.BRAND ? 'brand' : 'creator';
  if (plan.appliesTo !== expectedAppliesTo) throw ApiError.badRequest('This plan is not available for your account type');

  if (plan.price <= 0) throw ApiError.badRequest('This is a free plan — no checkout needed');

  await subscriptionService.ensureRazorpayPlan(plan);

  // total_count: how many billing cycles Razorpay will attempt before the
  // subscription naturally ends — set high enough to behave as "until
  // cancelled" (10 years' worth of cycles).
  const totalCount = plan.billingCycle === 'yearly' ? 10 : 120;

  const rzpSubscription = await razorpay.subscriptions.create({
    plan_id: plan.razorpayPlanId,
    customer_notify: 1,
    total_count: totalCount,
    notes: { userId: String(req.user._id), planId: String(plan._id) },
  });

  return new ApiResponse(
    200,
    { razorpaySubscriptionId: rzpSubscription.id, razorpayKeyId: process.env.RAZORPAY_KEY_ID },
    'Subscription checkout created'
  ).send(res);
});

// POST /api/subscriptions/verify  { razorpaySubscriptionId, razorpayPaymentId, razorpaySignature, planId }
// Called right after the Razorpay Checkout subscription flow succeeds, to
// give the user instant access without waiting for the webhook. The
// webhook (payment.controller.js) remains the source of truth for renewals.
const verifyCheckout = catchAsync(async (req, res) => {
  const { razorpaySubscriptionId, razorpayPaymentId, razorpaySignature, planId } = req.body;
  if (!razorpaySubscriptionId || !razorpayPaymentId || !razorpaySignature || !planId) {
    throw ApiError.badRequest('Missing payment verification fields');
  }

  const isValid = paymentService.verifySubscriptionSignature({ razorpaySubscriptionId, razorpayPaymentId, razorpaySignature });
  if (!isValid) throw ApiError.badRequest('Payment verification failed');

  const plan = await SubscriptionPlan.findById(planId);
  if (!plan) throw ApiError.notFound('Plan not found');

  let sub = await UserSubscription.findOne({ user: req.user._id });
  const periodEnd = subscriptionService.addCycle(new Date(), plan.billingCycle);

  if (!sub) {
    sub = new UserSubscription({ user: req.user._id });
  }
  sub.plan = plan._id;
  sub.status = SUBSCRIPTION_STATUS.ACTIVE;
  sub.razorpaySubscriptionId = razorpaySubscriptionId;
  sub.cancelAtPeriodEnd = false;
  sub.currentPeriodStart = new Date();
  sub.currentPeriodEnd = periodEnd;
  sub.proposalsUsedThisCycle = 0;
  sub.campaignsPostedThisCycle = 0;
  await sub.save();

  await Transaction.create({
    type: TRANSACTION_TYPE.SUBSCRIPTION_PAYMENT,
    from: req.user._id,
    amount: plan.price,
    status: TRANSACTION_STATUS.SUCCESS,
    razorpayPaymentId,
    relatedModel: 'UserSubscription',
    relatedId: sub._id,
    notes: `Subscribed to ${plan.name}`,
  });

  // Without this, `sub.plan` stays as just the ObjectId string — the
  // frontend then can't read sub.plan.name/price/_id etc. off the
  // response, which is exactly what caused the Pricing page's "Current
  // Plan" button to never highlight correctly right after upgrading.
  await sub.populate('plan');

  return new ApiResponse(200, sub, 'Subscription activated').send(res);
});

// POST /api/subscriptions/cancel — cancels at the end of the current paid period
const cancelSubscription = catchAsync(async (req, res) => {
  const sub = await UserSubscription.findOne({ user: req.user._id });
  if (!sub || !sub.razorpaySubscriptionId) throw ApiError.badRequest('No active paid subscription to cancel');

  await razorpay.subscriptions.cancel(sub.razorpaySubscriptionId, { cancel_at_cycle_end: 1 });
  sub.cancelAtPeriodEnd = true;
  await sub.save();

  return new ApiResponse(200, sub, 'Subscription will end at the current period').send(res);
});

module.exports = { listPlans, getMySubscription, createCheckout, verifyCheckout, cancelSubscription };