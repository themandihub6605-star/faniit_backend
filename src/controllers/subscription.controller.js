const razorpay = require('../config/razorpay');
const { SubscriptionPlan, UserSubscription, Transaction } = require('../models');
const paymentService = require('../services/payment.service');
const subscriptionService = require('../services/subscription.service');
const { sendSubscriptionConfirmationEmail } = require('../services/email.service');
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

  // The plan must be the one this Razorpay subscription was created for,
  // by this user — otherwise paying for a cheap plan could unlock any plan.
  const rzpSubscription = await razorpay.subscriptions.fetch(razorpaySubscriptionId);
  const notes = rzpSubscription.notes || {};
  if (
    rzpSubscription.plan_id !== plan.razorpayPlanId ||
    (notes.userId && String(notes.userId) !== String(req.user._id))
  ) {
    throw ApiError.badRequest('This payment does not match the selected plan');
  }

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

  // Point-Fix: confirmation email doubles as the receipt for this
  // payment — req.user.email/name come straight off the authenticated
  // user, no extra lookup needed.
  if (req.user.email) {
    sendSubscriptionConfirmationEmail({
      to: req.user.email,
      name: req.user.name,
      planName: plan.name,
      price: plan.price,
      billingCycle: plan.billingCycle,
    });
  }

  return new ApiResponse(200, sub, 'Subscription activated').send(res);
});

/** Razorpay SDK errors look like { statusCode, error: { code, description } } — no `message`. */
function rzpMessage(err) {
  return err?.error?.description || err?.message || (typeof err === 'string' ? err : 'Razorpay request failed');
}

// Razorpay subscription states where nothing is left to cancel (autopay already off).
const RZP_DONE = ['cancelled', 'completed', 'expired'];
// States where no payment has been taken yet — safe to cancel straight away.
const RZP_NOT_STARTED = ['created', 'authenticated'];

// POST /api/subscriptions/cancel — stops autopay; benefits stay until the end of the paid period
const cancelSubscription = catchAsync(async (req, res) => {
  const sub = await UserSubscription.findOne({ user: req.user._id });
  if (!sub || !sub.razorpaySubscriptionId) throw ApiError.badRequest('No active paid subscription to cancel');
  if (sub.cancelAtPeriodEnd) {
    await sub.populate('plan');
    return new ApiResponse(200, sub, 'Your plan is already cancelled — it ends at the end of this period').send(res);
  }

  const rzpId = sub.razorpaySubscriptionId;

  // 1) Where is this subscription on Razorpay right now?
  let rzpStatus = null;
  try {
    const rzpSub = await razorpay.subscriptions.fetch(rzpId);
    rzpStatus = rzpSub.status;
  } catch (err) {
    console.error(`[subscription] cancel: fetch ${rzpId} failed (${err?.statusCode}):`, rzpMessage(err));
    // 400 here = this id doesn't exist for the current Razorpay keys (e.g. made with test keys) —
    // there is no autopay on this account to stop, so just end it on our side.
    if (err?.statusCode !== 400) throw ApiError.badRequest(`Couldn't reach Razorpay: ${rzpMessage(err)}. Please try again.`);
  }

  // 2) Stop autopay on Razorpay.
  if (rzpStatus && !RZP_DONE.includes(rzpStatus)) {
    const atCycleEnd = !RZP_NOT_STARTED.includes(rzpStatus);
    try {
      await razorpay.subscriptions.cancel(rzpId, atCycleEnd);
    } catch (err) {
      console.error(`[subscription] cancel ${rzpId} (status ${rzpStatus}, atCycleEnd ${atCycleEnd}) failed:`, rzpMessage(err));
      if (!atCycleEnd) throw ApiError.badRequest(rzpMessage(err));
      // Cycle-end cancel refused (some payment methods/states don't allow it) — cancel now instead.
      // The user still keeps paid benefits until currentPeriodEnd: our side only downgrades
      // when that date passes (see subscription.service.js).
      try {
        await razorpay.subscriptions.cancel(rzpId, false);
      } catch (err2) {
        console.error(`[subscription] immediate cancel ${rzpId} failed:`, rzpMessage(err2));
        throw ApiError.badRequest(rzpMessage(err2));
      }
    }
  }

  // 3) Our side: no renewal; drops to the free plan when the paid period ends.
  sub.cancelAtPeriodEnd = true;
  await sub.save();
  await sub.populate('plan');

  return new ApiResponse(200, sub, 'Autopay stopped — your plan stays active until the end of this period').send(res);
});

module.exports = { listPlans, getMySubscription, createCheckout, verifyCheckout, cancelSubscription };