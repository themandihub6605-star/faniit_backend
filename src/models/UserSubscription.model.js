const mongoose = require('mongoose');
const { SUBSCRIPTION_STATUS } = require('../constants/enums');

/** One active row per user, tracking their current plan, billing period,
 * and usage counters for that period (proposals sent / campaigns posted).
 * Usage resets whenever the period rolls over — either via a Razorpay
 * `subscription.charged` webhook (paid plans) or lazily on next use
 * (free plans, or a lapsed paid plan that gets downgraded back to
 * the role's default plan — see subscription.service.js). */
const userSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true },

    status: { type: String, enum: Object.values(SUBSCRIPTION_STATUS), default: SUBSCRIPTION_STATUS.ACTIVE },

    currentPeriodStart: { type: Date, default: Date.now },
    currentPeriodEnd: { type: Date, required: true },

    // Razorpay Subscriptions integration (only set for paid plans)
    razorpaySubscriptionId: { type: String, default: '' },
    cancelAtPeriodEnd: { type: Boolean, default: false },

    // Usage counters for the current period — reset to 0 on rollover
    proposalsUsedThisCycle: { type: Number, default: 0 }, // creators
    campaignsPostedThisCycle: { type: Number, default: 0 }, // brands
  },
  { timestamps: true }
);

module.exports = mongoose.model('UserSubscription', userSubscriptionSchema);