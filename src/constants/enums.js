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
  AGENCY_COMMISSION: 'agency_commission',
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

module.exports = {
  ROLES,
  SESSION_TYPES,
  BOOKING_STATUS,
  CAMPAIGN_STATUS,
  APPLICATION_STATUS,
  TRANSACTION_TYPE,
  TRANSACTION_STATUS,
  VERIFICATION_STATUS,
};
