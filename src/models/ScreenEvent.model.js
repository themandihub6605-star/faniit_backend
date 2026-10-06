const mongoose = require('mongoose');

// One screen visit in the mobile app: which screen, how long it stayed open,
// and who (signed-in user, or an anonymous install before login).
// Only screen names and times are kept — never screen content.
// Rows delete themselves after 90 days.

const RETENTION_DAYS = 90;

const screenEventSchema = new mongoose.Schema(
  {
    screen: { type: String, required: true, trim: true, maxlength: 80 },
    durationMs: { type: Number, required: true, min: 0 },
    startedAt: { type: Date, required: true },

    // user id when signed in, otherwise "d:<installId>" — used for unique counts.
    visitor: { type: String, required: true, maxlength: 80 },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    role: { type: String, default: 'guest', maxlength: 20 },

    sessionId: { type: String, required: true, maxlength: 64 },
    platform: { type: String, default: '', maxlength: 20 },
    appVersion: { type: String, default: '', maxlength: 20 },

    createdAt: { type: Date, default: Date.now, expires: RETENTION_DAYS * 24 * 60 * 60 },
  },
  { versionKey: false }
);

screenEventSchema.index({ startedAt: -1, screen: 1 });
screenEventSchema.index({ startedAt: -1, role: 1 });
screenEventSchema.index({ sessionId: 1, startedAt: 1 });

module.exports = mongoose.model('ScreenEvent', screenEventSchema);
module.exports.RETENTION_DAYS = RETENTION_DAYS;