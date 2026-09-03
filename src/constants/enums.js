const ROLES = Object.freeze({
  FAN: 'fan',
  CREATOR: 'creator',
  BRAND: 'brand',
  AGENCY: 'agency',
  ADMIN: 'admin',
});

const SESSION_TYPES = Object.freeze({
  FREE: 'free',
  PAID: 'paid',
  ONE_TO_ONE: 'one_to_one',
});

const BOOKING_STATUS = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
});

const CAMPAIGN_STATUS = Object.freeze({
  DRAFT: 'draft',
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  COMPLETED: 'completed',
  DISPUTED: 'disputed',
  CANCELLED: 'cancelled',
});

const APPLICATION_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
});

const TRANSACTION_TYPE = Object.freeze({
  SESSION_PAYMENT: 'session_payment',
  DONATION: 'donation',
  CAMPAIGN_ESCROW_DEPOSIT: 'campaign_escrow_deposit',
  CAMPAIGN_PAYOUT: 'campaign_payout',
  CAMPAIGN_POSTING_FEE: 'campaign_posting_fee',
  AGENCY_COMMISSION: 'agency_commission',
  REFERRAL_COMMISSION: 'referral_commission',
  PLATFORM_COMMISSION: 'platform_commission',
  SUBSCRIPTION_PAYMENT: 'subscription_payment',
  EXTRA_PROPOSAL_FEE: 'extra_proposal_fee',
  REFUND: 'refund',
});

const TRANSACTION_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_ESCROW: 'in_escrow',
  SUCCESS: 'success',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  RELEASED: 'released',
});

const VERIFICATION_STATUS = Object.freeze({
  UNVERIFIED: 'unverified',
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
});

// --- Campaign creation wizard ---
const LOCATION_TYPE = Object.freeze({
  PAN_INDIA: 'pan_india',
  STATE: 'state',
  CITY: 'city',
});

const CAMPAIGN_TYPE = Object.freeze({
  PAID: 'paid',
  BARTER: 'barter',
});

const GENDER_TARGET = Object.freeze({
  MALE: 'male',
  FEMALE: 'female',
  OTHER: 'other',
});

// --- Subscriptions ---
const SUBSCRIPTION_APPLIES_TO = Object.freeze({
  CREATOR: 'creator',
  BRAND: 'brand',
});

const BILLING_CYCLE = Object.freeze({
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
});

const SUBSCRIPTION_STATUS = Object.freeze({
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

const CAMPAIGN_VISIBILITY_TIER = Object.freeze({
  LITE: 'lite',
  EXCLUSIVE: 'exclusive',
});

const CREATOR_CAMPAIGN_ACCESS = Object.freeze({
  LITE_ONLY: 'lite_only', // can only apply to 'lite' tier campaigns
  ALL: 'all', // can apply to lite + exclusive
});

// --- Milestone-based campaign escrow (Point 12, Upwork-style flow) ---
// pending -> funded -> submitted -> released
//                         |            ^
//                         v            |
//                  changes_requested --+ (creator resubmits -> submitted)
//                         |
//                         v (brand raises dispute instead)
//                     disputed -> released (admin resolves: full/partial/refund)
//                              -> funded (admin resolves: revision_required)
const MILESTONE_STATUS = Object.freeze({
  PENDING: 'pending', // created, brand hasn't funded it yet
  FUNDED: 'funded', // brand paid into escrow, creator can start work
  SUBMITTED: 'submitted', // creator submitted work, awaiting brand review
  CHANGES_REQUESTED: 'changes_requested', // brand asked for a revision, no money moved
  DISPUTED: 'disputed', // brand raised a dispute, awaiting admin resolution
  RELEASED: 'released', // funds released to creator (approved, auto-released, or dispute-resolved)
});

const DISPUTE_STATUS = Object.freeze({
  OPEN: 'open',
  RESOLVED: 'resolved',
});

const DISPUTE_OUTCOME = Object.freeze({
  FULL_TO_CREATOR: 'full_to_creator',
  PARTIAL: 'partial',
  REFUND_TO_BRAND: 'refund_to_brand',
  REVISION_REQUIRED: 'revision_required', // no money moves — milestone goes back to 'funded'
});

module.exports = {
  ROLES,
  SESSION_TYPES,
  BOOKING_STATUS,
  CAMPAIGN_STATUS,
  APPLICATION_STATUS,
  TRANSACTION_TYPE,
  TRANSACTION_STATUS,
  VERIFICATION_STATUS,
  LOCATION_TYPE,
  CAMPAIGN_TYPE,
  GENDER_TARGET,
  SUBSCRIPTION_APPLIES_TO,
  BILLING_CYCLE,
  SUBSCRIPTION_STATUS,
  CAMPAIGN_VISIBILITY_TIER,
  CREATOR_CAMPAIGN_ACCESS,
  MILESTONE_STATUS,
  DISPUTE_STATUS,
  DISPUTE_OUTCOME,
};