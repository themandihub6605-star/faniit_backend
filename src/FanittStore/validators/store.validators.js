const { z } = require('zod');
const mongoose = require('mongoose');
const {
  PAYOUT_METHOD,
  ID_TYPES,
  PRODUCT_CATEGORIES,
  PRODUCT_FILE_TYPES,
  LIMITS,
  TOOL_KEYS,
  LIVE_VISIBILITY,
  LIVE_PRIVATE_MODE,
  CALL_TYPE,
  FANBOX,
  AFFILIATE_EARNING_STATUS,
} = require('../constants');

const trimmed = (max) => z.string().trim().max(max);

// ---------- Creator: store setup ----------

const storeProfileSchema = z.object({
  name: z.string().trim().min(2, 'Store name must be at least 2 characters').max(60),
  tagline: trimmed(120).optional(),
  about: trimmed(1500).optional(),
});

const storeProfileUpdateSchema = storeProfileSchema.partial().extend({ isOpen: z.boolean().optional() });

const payoutSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal(PAYOUT_METHOD.UPI),
    upiId: z
      .string()
      .trim()
      .regex(/^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/, 'Enter a valid UPI ID (e.g. name@okaxis)'),
  }),
  z.object({
    method: z.literal(PAYOUT_METHOD.BANK),
    accountHolderName: z.string().trim().min(2, 'Enter the account holder name').max(100),
    accountNumber: z
      .string()
      .trim()
      .regex(/^\d{9,18}$/, 'Account number must be 9–18 digits'),
    ifsc: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code (e.g. HDFC0001234)'),
    bankName: trimmed(100).optional(),
  }),
]);

// KYC arrives as multipart form fields, so everything is a string.
const kycSchema = z.object({
  panNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Enter a valid PAN (e.g. ABCDE1234F)'),
  panName: z.string().trim().min(2, 'Enter the name exactly as on your PAN').max(100),
  idType: z.enum(ID_TYPES, { errorMap: () => ({ message: `ID type must be one of: ${ID_TYPES.join(', ')}` }) }),
});

const termsSchema = z.object({
  accept: z.literal(true, { errorMap: () => ({ message: 'You must accept the store terms' }) }),
  version: z.string().trim().min(1),
});

// ---------- Creator: products ----------

const price = z
  .number({ invalid_type_error: 'Price must be a number (in paise)' })
  .int('Price must be in whole paise')
  .min(LIMITS.MIN_PRICE)
  .max(LIMITS.MAX_PRICE, 'Price is too high');

const productCreateSchema = z.object({
  title: z.string().trim().min(3, 'Title must be at least 3 characters').max(120),
  description: trimmed(5000).optional(),
  category: z.enum(PRODUCT_CATEGORIES).optional(),
  price,
});

const productUpdateSchema = productCreateSchema.partial();

const fileUploadRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(PRODUCT_FILE_TYPES, { errorMap: () => ({ message: 'This file type is not supported' }) }),
  size: z
    .number()
    .int()
    .positive()
    .max(LIMITS.MAX_FILE_BYTES, `Each file can be up to ${LIMITS.MAX_FILE_BYTES / (1024 * 1024)} MB`),
});

const fileConfirmSchema = z.object({
  key: z.string().trim().min(10).max(500),
  fileName: z.string().trim().min(1).max(200),
});

// ---------- Creator: live streams ----------

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');

const liveFields = {
  title: z.string().trim().min(3, 'Title must be at least 3 characters').max(120),
  description: trimmed(2000).optional(),
  visibility: z.enum(Object.values(LIVE_VISIBILITY)).optional(),
  privateMode: z.enum(Object.values(LIVE_PRIVATE_MODE)).nullable().optional(),
  communityId: objectId.nullable().optional(),
  allowedUserIds: z.array(objectId).max(LIMITS.LIVE_SELECTED_USERS_MAX).optional(),
  price: price.optional(),
  chatEnabled: z.boolean().optional(),
  fanboxEnabled: z.boolean().optional(),
  // ISO date; leave out (or null) to go live right away.
  scheduledAt: z
    .string()
    .datetime({ offset: true, message: 'scheduledAt must be an ISO date-time' })
    .nullable()
    .optional(),
};

function checkLiveRules(value, ctx) {
  if (value.visibility === LIVE_VISIBILITY.PRIVATE) {
    if (!value.privateMode) ctx.addIssue({ code: 'custom', path: ['privateMode'], message: 'Choose who can watch this private live' });
    if (value.privateMode === LIVE_PRIVATE_MODE.COMMUNITY && !value.communityId) {
      ctx.addIssue({ code: 'custom', path: ['communityId'], message: 'Choose the community' });
    }
    if (value.privateMode === LIVE_PRIVATE_MODE.SELECTED && !(value.allowedUserIds || []).length) {
      ctx.addIssue({ code: 'custom', path: ['allowedUserIds'], message: 'Pick at least one person' });
    }
  }
  if (value.scheduledAt) {
    const when = new Date(value.scheduledAt).getTime();
    if (when < Date.now() - 60 * 1000) ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: 'Pick a time in the future' });
    if (when > Date.now() + LIMITS.LIVE_MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000) {
      ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: `You can schedule up to ${LIMITS.LIVE_MAX_SCHEDULE_DAYS} days ahead` });
    }
  }
}

const liveCreateSchema = z.object(liveFields).superRefine(checkLiveRules);
const liveUpdateSchema = z.object(liveFields).partial();

// ---------- Creator: calls ----------

const rate = z.number().int('Rate must be in whole paise').min(0).max(LIMITS.CALL_MAX_RATE, 'Rate is too high');

const callSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  audioEnabled: z.boolean().optional(),
  videoEnabled: z.boolean().optional(),
  audioRate: rate.optional(),
  videoRate: rate.optional(),
});

const callOnlineSchema = z.object({ online: z.boolean() });

// ---------- Creator: affiliate ----------

const httpsUrl = z.string().trim().url('Enter a full link starting with https://').max(2000);

const affiliatePreviewSchema = z.object({ url: httpsUrl });

const affiliateProductSchema = z.object({
  url: httpsUrl,
  title: z.string().trim().min(2, 'Add a product name').max(150),
  description: trimmed(1000).optional(),
  imageUrl: z.union([z.literal(''), httpsUrl]).optional(),
  price: price.nullable().optional(),
  merchant: trimmed(60).optional(),
  category: trimmed(40).optional(),
});

const affiliateProductUpdateSchema = affiliateProductSchema.partial().extend({
  hidden: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});

const affiliateCollectionSchema = z.object({
  title: z.string().trim().min(2).max(80),
  description: trimmed(500).optional(),
  isPublic: z.boolean().optional(),
  productIds: z.array(objectId).max(LIMITS.AFFILIATE_COLLECTION_PRODUCTS_MAX).optional(),
});

const affiliateCollectionUpdateSchema = affiliateCollectionSchema.partial().extend({ sortOrder: z.number().int().min(0).max(10000).optional() });

const affiliateEarningSchema = z.object({
  amount: z.number().int('Amount must be in whole paise').min(0).max(1000000000),
  merchant: trimmed(60).optional(),
  productId: objectId.nullable().optional(),
  orders: z.number().int().min(0).max(100000).optional(),
  status: z.enum(Object.values(AFFILIATE_EARNING_STATUS)).optional(),
  earnedAt: z.string().datetime({ offset: true }).optional(),
  note: trimmed(300).optional(),
});

const affiliateEarningUpdateSchema = affiliateEarningSchema.partial();

// ---------- Buyer ----------

const payWith = z.enum(['razorpay', 'wallet']).optional();

const checkoutSchema = z.object({ payWith, invite: z.string().trim().max(40).optional() }).default({});

const joinLiveSchema = z.object({ invite: z.string().trim().max(40).optional() }).default({});

const fanboxSchema = z
  .object({
    creatorId: objectId.optional(),
    storeId: objectId.optional(),
    amount: z
      .number()
      .int('Amount must be in whole paise')
      .min(FANBOX.MIN_AMOUNT, `Minimum ₹${FANBOX.MIN_AMOUNT / 100}`)
      .max(FANBOX.MAX_AMOUNT, `Maximum ₹${FANBOX.MAX_AMOUNT / 100}`),
    message: trimmed(200).optional(),
    context: z.enum(FANBOX.CONTEXTS).optional(),
    payWith,
  })
  .refine((v) => v.creatorId || v.storeId, { message: 'creatorId or storeId is required', path: ['creatorId'] });

const callRequestSchema = z.object({
  type: z.enum(Object.values(CALL_TYPE)),
  minutes: z.number().int().min(LIMITS.CALL_MIN_MINUTES).max(LIMITS.CALL_MAX_MINUTES, `Up to ${LIMITS.CALL_MAX_MINUTES} minutes`),
  note: trimmed(300).optional(),
  payWith,
});

const verifyPaymentSchema = z.object({
  razorpayOrderId: z.string().trim().min(1),
  razorpayPaymentId: z.string().trim().min(1),
  razorpaySignature: z.string().trim().min(1),
});

// ---------- Admin ----------

const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500) });

const kycDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }),
  z.object({ decision: z.literal('reject'), reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500) }),
]);

const storeStatusSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('suspend'), reason: z.string().trim().min(5).max(500) }),
  z.object({ action: z.literal('reinstate') }),
]);

const settingsSchema = z.object({
  storeFeePercent: z.number().min(0).max(50).optional(),
  fanboxFeePercent: z.number().min(0).max(50).optional(),
  termsVersion: z.string().trim().min(1).max(20).optional(),
  termsText: z.string().trim().min(20).max(20000).optional(),
});

const toolCardSchema = z.object({
  title: z.string().trim().min(2).max(40).optional(),
  description: trimmed(160).optional(),
  enabled: z.boolean().optional(),
  order: z.number().int().min(0).max(100).optional(),
});

const bannerSchema = z.object({
  enabled: z.boolean().optional(),
  title: trimmed(80).optional(),
  subtitle: trimmed(160).optional(),
  buttonText: trimmed(30).optional(),
  playStoreUrl: z.union([z.literal(''), z.string().trim().url('Enter a full https:// link')]).optional(),
  appDeepLink: trimmed(200).optional(),
  imageUrl: z.union([z.literal(''), z.string().trim().url()]).optional(),
});

const toolKeyParam = z.enum(TOOL_KEYS);

module.exports = {
  storeProfileSchema,
  storeProfileUpdateSchema,
  payoutSchema,
  kycSchema,
  termsSchema,
  productCreateSchema,
  productUpdateSchema,
  fileUploadRequestSchema,
  fileConfirmSchema,
  verifyPaymentSchema,
  reasonSchema,
  kycDecisionSchema,
  storeStatusSchema,
  settingsSchema,
  toolCardSchema,
  bannerSchema,
  toolKeyParam,
  liveCreateSchema,
  liveUpdateSchema,
  callSettingsSchema,
  callOnlineSchema,
  checkoutSchema,
  joinLiveSchema,
  callRequestSchema,
  fanboxSchema,
  affiliatePreviewSchema,
  affiliateProductSchema,
  affiliateProductUpdateSchema,
  affiliateCollectionSchema,
  affiliateCollectionUpdateSchema,
  affiliateEarningSchema,
  affiliateEarningUpdateSchema,
};
