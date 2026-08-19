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
};