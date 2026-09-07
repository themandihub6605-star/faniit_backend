const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
    // Set ONLY for creator<->brand conversations — ties this thread to
    // the specific proposal it came from. A creator applying to 3
    // campaigns from the same brand gets 3 separate threads, not one.
    // Stays null for any other pairing (e.g. fan<->creator), which can
    // still message freely without going through a proposal at all.
    application: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', default: null, index: true },
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },
    lastMessage: { type: String, default: '' },
    lastMessageAt: { type: Date, default: Date.now },
    unreadCounts: { type: Map, of: Number, default: {} },
  },
  { timestamps: true }
);

conversationSchema.index({ participants: 1 });
// One conversation per proposal, enforced at the DB level (not just the
// find-or-create logic in the controller) — the partial filter means
// this uniqueness rule only applies to documents that actually HAVE an
// application set, so ordinary null-application conversations (fan<->
// creator etc.) are unaffected.
conversationSchema.index(
  { application: 1 },
  { unique: true, partialFilterExpression: { application: { $type: 'objectId' } } }
);

module.exports = mongoose.model('Conversation', conversationSchema);