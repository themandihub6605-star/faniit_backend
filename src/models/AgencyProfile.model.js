const mongoose = require('mongoose');
const { VERIFICATION_STATUS } = require('../constants/enums');

const agencyProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

    agencyName: { type: String, required: true, trim: true },
    logoUrl: { type: String, default: '' },

    referralCode: { type: String, required: true, unique: true, index: true },
    commissionPercent: { type: Number, default: 5 }, // admin-configurable per agency

    verificationStatus: {
      type: String,
      enum: Object.values(VERIFICATION_STATUS),
      default: VERIFICATION_STATUS.UNVERIFIED,
    },

    referredCreators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'CreatorProfile' }],

    totalCommissionEarned: { type: Number, default: 0 },
    thisMonthCommission: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AgencyProfile', agencyProfileSchema);
