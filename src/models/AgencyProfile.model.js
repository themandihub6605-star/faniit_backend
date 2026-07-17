const mongoose = require('mongoose');
const { VERIFICATION_STATUS } = require('../constants/enums');

const agencyProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

    agencyName: { type: String, required: true, trim: true },
    ownerName: { type: String, default: '' },
    mobile: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    gstNumber: { type: String, default: '' },
    teamSize: { type: String, default: '' }, // e.g. "1-10"
    yearsInBusiness: { type: Number, default: null },
    specialization: { type: String, default: '' }, // e.g. "Fashion & Lifestyle creators"
    documentUrl: { type: String, default: '' }, // ID/address proof upload
    logoUrl: { type: String, default: '' },

    referralCode: { type: String, required: true, unique: true, index: true },
    commissionPercent: { type: Number, default: 5 }, // admin-configurable per agency

    // unverified = just registered, not yet submitted for approval
    // pending = submitted, waiting on admin
    // verified = approved, can access the dashboard
    // rejected = admin declined
    verificationStatus: {
      type: String,
      enum: Object.values(VERIFICATION_STATUS),
      default: VERIFICATION_STATUS.UNVERIFIED,
    },
    rejectionReason: { type: String, default: '' },

    referredCreators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'CreatorProfile' }],
    referredBrands: [{ type: mongoose.Schema.Types.ObjectId, ref: 'BrandProfile' }],

    totalCommissionEarned: { type: Number, default: 0 }, // in paise
    thisMonthCommission: { type: Number, default: 0 }, // in paise
  },
  { timestamps: true }
);

module.exports = mongoose.model('AgencyProfile', agencyProfileSchema);
