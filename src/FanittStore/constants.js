// Every enum and limit used by Fanitt Store lives here, so the rules are
// easy to find and change in one place.

const STORE_STATUS = Object.freeze({
  DRAFT: 'draft', // creator is still filling the setup steps
  PENDING_REVIEW: 'pending_review', // all steps done, waiting for admin KYC review
  ACTIVE: 'active', // live — can sell
  REJECTED: 'rejected', // KYC rejected — creator fixes and resubmits
  SUSPENDED: 'suspended', // blocked by admin
});

const KYC_STATUS = Object.freeze({
  NOT_SUBMITTED: 'not_submitted',
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
});

const ID_TYPES = Object.freeze(['aadhaar', 'passport', 'driving_licence', 'voter_id']);

const PAYOUT_METHOD = Object.freeze({ UPI: 'upi', BANK: 'bank' });

const PRODUCT_STATUS = Object.freeze({
  DRAFT: 'draft',
  PUBLISHED: 'published',
  UNPUBLISHED: 'unpublished',
  REMOVED: 'removed', // taken down by admin
});

const PRODUCT_CATEGORIES = Object.freeze([
  'course',
  'ebook',
  'template',
  'video',
  'audio',
  'guide',
  'other',
]);

const ORDER_STATUS = Object.freeze({
  PENDING: 'pending', // Razorpay order created, not paid yet
  PAID: 'paid',
  FAILED: 'failed',
  REFUNDED: 'refunded',
});

// What an order is for.
const ORDER_ITEM = Object.freeze({
  DIGITAL_PRODUCT: 'digital_product',
  LIVE_STREAM: 'live_stream', // ticket for a paid live
  CALL: 'call', // prepaid call minutes
  FANBOX: 'fanbox', // a tip — itemId is the creator's CreatorProfile id
  COMMUNITY: 'community', // paid community plan — itemId is the Community id, context is the plan
});

// ---------- FanBox ----------
const FANBOX = Object.freeze({
  PRESETS: [5000, 10000, 50000, 100000], // ₹50, ₹100, ₹500, ₹1,000
  MIN_AMOUNT: 1000, // ₹10
  MAX_AMOUNT: 10000000, // ₹1,00,000
  CONTEXTS: ['profile', 'store', 'live', 'community', 'post', 'other'],
});

// ---------- Affiliate ----------
const AFFILIATE_STATUS = Object.freeze({ ACTIVE: 'active', HIDDEN: 'hidden', REMOVED: 'removed' });
const AFFILIATE_EARNING_STATUS = Object.freeze({ PENDING: 'pending', CONFIRMED: 'confirmed', REVERSED: 'reversed' });

// How an order was paid.
const PAY_WITH = Object.freeze({ RAZORPAY: 'razorpay', WALLET: 'wallet', FREE: 'free' });

// ---------- Live streams ----------
const LIVE_STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  LIVE: 'live',
  ENDED: 'ended',
  CANCELLED: 'cancelled',
});

const LIVE_VISIBILITY = Object.freeze({ PUBLIC: 'public', PRIVATE: 'private' });

// Who can watch a PRIVATE live.
const LIVE_PRIVATE_MODE = Object.freeze({
  INVITE: 'invite', // anyone with the invite link
  COMMUNITY: 'community', // active members of one of the creator's communities
  SELECTED: 'selected', // hand-picked users
});

// ---------- Calls ----------
const CALL_TYPE = Object.freeze({ AUDIO: 'audio', VIDEO: 'video' });

const CALL_STATUS = Object.freeze({
  AWAITING_PAYMENT: 'awaiting_payment', // paid call, checkout not finished
  REQUESTED: 'requested', // waiting for the creator to accept
  ACTIVE: 'active', // accepted — both can join
  COMPLETED: 'completed',
  DECLINED: 'declined',
  MISSED: 'missed', // creator didn't answer in time
  CANCELLED: 'cancelled', // caller cancelled before it started
});

const CALL_FINAL_STATUSES = Object.freeze([CALL_STATUS.COMPLETED, CALL_STATUS.DECLINED, CALL_STATUS.MISSED, CALL_STATUS.CANCELLED]);

// The seven tools shown on Store Home. Titles/descriptions/images are
// editable from the admin panel (StoreSettings.toolCards).
const TOOL_KEYS = Object.freeze(['virtual_meet', 'stream_live', 'chat_calls', 'digital_products', 'community', 'affiliate', 'fanbox']);

const LIMITS = Object.freeze({
  FILES_PER_PRODUCT: 10,
  MAX_FILE_BYTES: 500 * 1024 * 1024, // 500 MB
  MIN_PRICE: 0, // 0 = free product
  MAX_PRICE: 10000000, // ₹1,00,000 in paise
  UPLOAD_URL_TTL_SECONDS: 60 * 60, // presigned upload link lifetime
  DOWNLOAD_URL_TTL_SECONDS: 10 * 60, // presigned download link lifetime
  KYC_DOC_MAX_BYTES: 8 * 1024 * 1024,

  // Live
  LIVE_MAX_SCHEDULE_DAYS: 90,
  LIVE_SELECTED_USERS_MAX: 500,
  LIVE_TOKEN_TTL: '6h',

  // Calls
  CALL_MIN_MINUTES: 1,
  CALL_MAX_MINUTES: 120,
  CALL_MAX_RATE: 1000000, // ₹10,000 per minute, in paise
  CALL_RING_TIMEOUT_MS: 2 * 60 * 1000, // creator must answer within 2 minutes
  CALL_CONNECT_TIMEOUT_MS: 3 * 60 * 1000, // both must join within 3 minutes of accepting
  CALL_GRACE_MS: 15 * 1000, // small grace before the prepaid time runs out
  CALL_TOKEN_TTL: '3h',
  JOB_INTERVAL_MS: 20 * 1000,

  // Affiliate
  AFFILIATE_PRODUCTS_MAX: 500,
  AFFILIATE_COLLECTIONS_MAX: 50,
  AFFILIATE_COLLECTION_PRODUCTS_MAX: 100,
  PREVIEW_TIMEOUT_MS: 6000,
  PREVIEW_MAX_BYTES: 1024 * 1024,

  // Analytics
  ANALYTICS_MAX_DAYS: 365,
});

// Allowed digital product file types.
const PRODUCT_FILE_TYPES = Object.freeze([
  'application/pdf',
  'application/epub+zip',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/ogg',
]);

const DEFAULT_FEES = Object.freeze({ STORE_FEE_PERCENT: 9, FANBOX_FEE_PERCENT: 3 });

module.exports = {
  FANBOX,
  AFFILIATE_STATUS,
  AFFILIATE_EARNING_STATUS,
  PAY_WITH,
  LIVE_STATUS,
  LIVE_VISIBILITY,
  LIVE_PRIVATE_MODE,
  CALL_TYPE,
  CALL_STATUS,
  CALL_FINAL_STATUSES,
  STORE_STATUS,
  KYC_STATUS,
  ID_TYPES,
  PAYOUT_METHOD,
  PRODUCT_STATUS,
  PRODUCT_CATEGORIES,
  ORDER_STATUS,
  ORDER_ITEM,
  TOOL_KEYS,
  LIMITS,
  PRODUCT_FILE_TYPES,
  DEFAULT_FEES,
};