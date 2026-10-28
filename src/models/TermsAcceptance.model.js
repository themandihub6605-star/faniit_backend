// File: src/models/TermsAcceptance.model.js
const mongoose = require('mongoose');

// When a user agreed to the Terms of Use (and which version). Apple and
// Google want users to accept the rules on objectionable content.
const termsAcceptanceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    version: { type: String, required: true },
    acceptedAt: { type: Date, default: Date.now },
    platform: { type: String, default: '' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('TermsAcceptance', termsAcceptanceSchema);