const mongoose = require('mongoose');
const { STORE_STATUS, KYC_STATUS, ID_TYPES, PAYOUT_METHOD } = require('../constants');

// One store per creator. Setup is four steps (profile → payout → KYC →
// terms); when all four are done the store goes to admin review, and the
// admin approving the KYC makes it active.

const payoutSchema = new mongoose.Schema(
  {
    method: { type: String, enum: Object.values(PAYOUT_METHOD), required: true },
    upiId: { type: String, trim: true, default: '' },
    accountHolderName: { type: String, trim: true, default: '' },
    accountNumber: { type: String, trim: true, default: '' },
    ifsc: { type: String, trim: true, uppercase: true, default: '' },
    bankName: { type: String, trim: true, default: '' },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const kycSchema = new mongoose.Schema(
  {
    status: { type: String, enum: Object.values(KYC_STATUS), default: KYC_STATUS.NOT_SUBMITTED },
    panNumber: { type: String, trim: true, uppercase: true, default: '' },
    panName: { type: String, trim: true, default: '' },
    idType: { type: String, enum: [...ID_TYPES, ''], default: '' },
    // Private storage keys — never public URLs. Admins view them through
    // short-lived signed links.
    panDocumentKey: { type: String, default: '' },
    idDocumentKey: { type: String, default: '' },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: { type: String, default: '' },
  },
  { _id: false }
);

const storeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'CreatorProfile', required: true, unique: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },

    // Step 1 — store profile
    name: { type: String, required: true, trim: true, maxlength: 60 },
    tagline: { type: String, trim: true, maxlength: 120, default: '' },
    about: { type: String, trim: true, maxlength: 1500, default: '' },
    logoUrl: { type: String, default: '' },
    bannerUrl: { type: String, default: '' },

    // Step 2 — payout details (sensitive: hidden unless explicitly selected)
    payout: { type: payoutSchema, default: null, select: false },
    hasPayout: { type: Boolean, default: false },

    // Step 3 — KYC (document keys hidden unless explicitly selected)
    kyc: { type: kycSchema, default: () => ({}), select: false },
    kycStatus: { type: String, enum: Object.values(KYC_STATUS), default: KYC_STATUS.NOT_SUBMITTED, index: true },

    // Step 4 — terms
    termsAcceptedAt: { type: Date, default: null },
    termsVersion: { type: String, default: '' },

    status: { type: String, enum: Object.values(STORE_STATUS), default: STORE_STATUS.DRAFT, index: true },
    statusReason: { type: String, default: '' },
    activatedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },

    // Creator can close the store for a while without losing anything.
    isOpen: { type: Boolean, default: true },

    // 1-to-1 calls. Rates are per minute in paise (0 = free).
    calls: {
      enabled: { type: Boolean, default: false },
      audioEnabled: { type: Boolean, default: true },
      videoEnabled: { type: Boolean, default: true },
      audioRate: { type: Number, default: 0, min: 0 },
      videoRate: { type: Number, default: 0, min: 0 },
      online: { type: Boolean, default: false },
      lastOnlineAt: { type: Date, default: null },
    },

    // Running totals (paise) — kept in sync by the earnings service.
    stats: {
      views: { type: Number, default: 0 },
      orders: { type: Number, default: 0 },
      grossSales: { type: Number, default: 0 },
      feesPaid: { type: Number, default: 0 },
      netEarnings: { type: Number, default: 0 },
      refunds: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

storeSchema.index({ status: 1, createdAt: -1 });
storeSchema.index({ name: 'text', tagline: 'text' });

module.exports = mongoose.models.Store || mongoose.model('Store', storeSchema);
