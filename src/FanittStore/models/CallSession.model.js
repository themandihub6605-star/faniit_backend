const mongoose = require('mongoose');
const { CALL_TYPE, CALL_STATUS } = require('../constants');

// A 1-to-1 audio/video call between a buyer (caller) and a creator (host).
// Paid calls are prepaid: the caller buys N minutes up front, the call is
// billed per started minute, and unused minutes go back to their wallet.

const callSessionSchema = new mongoose.Schema(
  {
    store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    caller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    type: { type: String, enum: Object.values(CALL_TYPE), required: true },
    ratePerMinute: { type: Number, required: true, min: 0 }, // paise, frozen at request time
    prepaidMinutes: { type: Number, required: true, min: 1 },
    prepaidAmount: { type: Number, default: 0 }, // paise
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreOrder', default: null },

    note: { type: String, trim: true, maxlength: 300, default: '' }, // what the caller wants to talk about

    status: { type: String, enum: Object.values(CALL_STATUS), required: true, index: true },
    requestedAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    hostJoinedAt: { type: Date, default: null },
    callerJoinedAt: { type: Date, default: null },
    connectedAt: { type: Date, default: null }, // both joined — billing starts
    endedAt: { type: Date, default: null },
    endedBy: { type: String, enum: ['host', 'caller', 'system', 'admin', ''], default: '' },
    endReason: { type: String, default: '' },

    billedMinutes: { type: Number, default: 0 },
    billedAmount: { type: Number, default: 0 },
    refundedAmount: { type: Number, default: 0 },
    creatorEarning: { type: Number, default: 0 },
    settledAt: { type: Date, default: null },

    roomName: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

callSessionSchema.index({ status: 1, requestedAt: 1 });
callSessionSchema.index({ status: 1, connectedAt: 1 });

module.exports = mongoose.models.CallSession || mongoose.model('CallSession', callSessionSchema);
