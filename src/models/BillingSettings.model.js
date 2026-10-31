const mongoose = require('mongoose');

// Singleton (_id: 'default') — everything about money and agreements that
// the admin can change from the panel without a deploy:
//   • GST on/off and rate, on the withdrawal fee and on brand payments
//   • creator minimum withdrawal and the fallback platform fee
//   • business details printed on invoices
//   • the creator / brand agreement texts and whether they're required
// Per-plan platform fees (Lite, Pro…) live on SubscriptionPlan.platformFeePercent.

const DEFAULT_CREATOR_AGREEMENT =
  'I will deliver the work for this campaign on time, as per the timeline I quote, and to the quality agreed with the brand. ' +
  'I will talk and share work only through Fanitt, keep the brand’s information private, and never ask for or accept payment outside Fanitt. ' +
  'If I don’t deliver or I break these terms, Fanitt may refund the escrow payment to the brand and may restrict my account.';

const DEFAULT_BRAND_AGREEMENT =
  'The campaign details I post are true. I will pay the agreed amount into Fanitt escrow before work starts, give clear feedback, ' +
  'and review submitted work on time. I will never ask for or make payment outside Fanitt. ' +
  'If I cancel or don’t review without a valid reason, Fanitt may release the escrow payment to the creator and may restrict my account.';

const billingSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'default' },

    // --- GST ---
    gstEnabled: { type: Boolean, default: true },
    gstPercent: { type: Number, default: 18, min: 0, max: 50 },
    // GST on Fanitt's platform fee when a creator withdraws.
    gstOnWithdrawalFee: { type: Boolean, default: true },
    // GST added on top when a brand pays for a campaign / milestone.
    gstOnBrandPayments: { type: Boolean, default: true },

    // --- Withdrawals ---
    creatorMinWithdrawal: { type: Number, default: 100000, min: 0 }, // paise (₹1,000)
    // Used only when a creator's plan has no fee set.
    defaultCreatorFeePercent: { type: Number, default: 10, min: 0, max: 100 },

    // --- Invoices ---
    invoicePrefix: { type: String, default: 'FAN', trim: true, maxlength: 10 },
    businessName: { type: String, default: 'Fanitt', trim: true, maxlength: 120 },
    businessGstin: { type: String, default: '', trim: true, uppercase: true, maxlength: 20 },
    businessAddress: { type: String, default: '', trim: true, maxlength: 400 },
    businessEmail: { type: String, default: 'support@fanitt.com', trim: true, maxlength: 120 },

    // --- Agreements ---
    agreementsEnabled: { type: Boolean, default: true },
    creatorAgreementText: { type: String, default: DEFAULT_CREATOR_AGREEMENT, maxlength: 4000 },
    brandAgreementText: { type: String, default: DEFAULT_BRAND_AGREEMENT, maxlength: 4000 },
    // Goes up by one whenever either text changes — saved with each acceptance.
    agreementVersion: { type: Number, default: 1 },
  },
  { timestamps: true, _id: false }
);

billingSettingsSchema.statics.getSingleton = async function getSingleton() {
  let settings = await this.findById('default');
  if (!settings) settings = await this.create({ _id: 'default' });
  return settings;
};

billingSettingsSchema.statics.DEFAULT_CREATOR_AGREEMENT = DEFAULT_CREATOR_AGREEMENT;
billingSettingsSchema.statics.DEFAULT_BRAND_AGREEMENT = DEFAULT_BRAND_AGREEMENT;

module.exports = mongoose.models.BillingSettings || mongoose.model('BillingSettings', billingSettingsSchema);
