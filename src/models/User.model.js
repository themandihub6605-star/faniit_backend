const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ROLES } = require('../constants/enums');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: {
      type: String,
      required: function isPasswordRequired() {
        return this.authProvider !== 'google';
      },
      minlength: 8,
      select: false,
    },
    phone: { type: String, trim: true },
    avatarUrl: { type: String, default: '' },

    authProvider: { type: String, enum: ['local', 'google'], default: 'local' },
    googleId: { type: String, default: null, index: true, sparse: true },

    // Referral system — applies to all 4 roles (Fan/Creator/Brand/Agency).
    // Every user gets their own shareable code; referredBy records whose
    // code they entered at signup (if any), so commission can be traced
    // back through User.role -> User.role pairs against ReferralConfig.
    referralCode: { type: String, unique: true, sparse: true, index: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    role: { type: String, enum: Object.values(ROLES), default: ROLES.FAN },
    // A user can hold multiple roles over time (Fan -> also Creator, etc.)
    roles: { type: [String], enum: Object.values(ROLES), default: [ROLES.FAN] },

    isEmailVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    isSuspended: { type: Boolean, default: false },
    suspensionReason: { type: String, default: '' },

    walletBalance: { type: Number, default: 0 }, // in paise, avoids float rounding issues

    passwordResetToken: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },

    referredByAgency: { type: mongoose.Schema.Types.ObjectId, ref: 'AgencyProfile', default: null },

    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

userSchema.index({ role: 1 });

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.pre('save', async function assignReferralCode(next) {
  if (this.referralCode) return next();
  const base = (this.name || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8) || 'user';
  let attempt = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
  // Extremely unlikely to collide, but guard against it anyway.
  while (await this.constructor.exists({ referralCode: attempt })) {
    attempt = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
  }
  this.referralCode = attempt.toUpperCase();
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toSafeObject = function toSafeObject() {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);