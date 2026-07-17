const mongoose = require('mongoose');
const { BOOKING_STATUS } = require('../constants/enums');

const bookingSchema = new mongoose.Schema(
  {
    session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    status: { type: String, enum: Object.values(BOOKING_STATUS), default: BOOKING_STATUS.PENDING },

    amountPaid: { type: Number, default: 0 },
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },

    joinedAt: { type: Date, default: null },
    attended: { type: Boolean, default: false },

    reminderSent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// A user can only book the same session once
bookingSchema.index({ session: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('Booking', bookingSchema);
