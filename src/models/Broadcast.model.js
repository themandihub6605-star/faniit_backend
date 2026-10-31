const mongoose = require('mongoose');

// Admin broadcast notifications: sent now or at a scheduled time. The
// scheduler (services/broadcast.service.js) picks up due ones every 30s,
// so scheduled sends survive server restarts.
const STATUSES = ['scheduled', 'sending', 'sent', 'failed', 'cancelled'];
const AUDIENCE_ROLES = ['fan', 'creator', 'brand', 'agency'];

// Extra audience filters on top of roles. 'any' / null = filter not used.
const PLAN_FILTERS = ['any', 'free', 'paid', 'expiring', 'plans'];
const VERIFICATION_FILTERS = ['any', 'verified', 'unverified', 'pending', 'rejected'];
const YES_NO = ['any', 'yes', 'no'];

const filtersSchema = new mongoose.Schema(
  {
    // free = no paid plan right now · paid = on a paid plan right now ·
    // expiring = paid plan ends within 7 days and won't renew · plans = only planIds
    plan: { type: String, enum: PLAN_FILTERS, default: 'any' },
    planIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan' }], default: [] },
    // Creator / brand / agency profile verification
    verification: { type: String, enum: VERIFICATION_FILTERS, default: 'any' },
    onboarded: { type: String, enum: YES_NO, default: 'any' }, // finished signup
    emailVerified: { type: String, enum: YES_NO, default: 'any' },
    loginWithinDays: { type: Number, default: null, min: 1, max: 3650 }, // logged in recently
    inactiveDays: { type: Number, default: null, min: 1, max: 3650 }, // no login for N+ days
    joinedWithinDays: { type: Number, default: null, min: 1, max: 3650 },
    appOnly: { type: Boolean, default: false }, // only accounts with the app + push on
  },
  { _id: false }
);

const broadcastSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 100 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    imageUrl: { type: String, default: '' },
    // Optional link opened when the notification is tapped: a full https URL
    // or a website path like /communities.
    link: { type: String, default: '', maxlength: 500 },

    // Empty roles = everyone. testEmail = send only to that one account.
    roles: { type: [{ type: String, enum: AUDIENCE_ROLES }], default: [] },
    testEmail: { type: String, default: '', lowercase: true, trim: true },
    filters: { type: filtersSchema, default: () => ({}) },

    status: { type: String, enum: STATUSES, default: 'scheduled', index: true },
    scheduledAt: { type: Date, default: Date.now, index: true },
    sentAt: { type: Date, default: null },
    error: { type: String, default: '' },

    stats: {
      targeted: { type: Number, default: 0 },
      inApp: { type: Number, default: 0 },
      devices: { type: Number, default: 0 },
      pushSent: { type: Number, default: 0 },
      pushFailed: { type: Number, default: 0 },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

broadcastSchema.index({ status: 1, scheduledAt: 1 });

broadcastSchema.statics.STATUSES = STATUSES;
broadcastSchema.statics.AUDIENCE_ROLES = AUDIENCE_ROLES;
broadcastSchema.statics.PLAN_FILTERS = PLAN_FILTERS;
broadcastSchema.statics.VERIFICATION_FILTERS = VERIFICATION_FILTERS;
broadcastSchema.statics.YES_NO = YES_NO;

module.exports = mongoose.model('Broadcast', broadcastSchema);