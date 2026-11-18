// File: src/models/WhatsAppAccount.model.js
const mongoose = require('mongoose');

// A WhatsApp Business number a Fanitt user connected with Meta's
// Embedded Signup (fanitt.com/connect/whatsapp). One number per user.
//
// The Meta access token is never sent to any client (select: false).
// The last messages (sent from Fanitt and replies that came in through the
// webhook) are kept here so the connect page can show them.

const messageSchema = new mongoose.Schema(
  {
    direction: { type: String, enum: ['in', 'out'], required: true },
    waMessageId: { type: String, default: '' },
    peer: { type: String, default: '' }, // the other phone number (digits)
    kind: { type: String, default: 'text' }, // text | template | image | …
    text: { type: String, default: '' },
    status: { type: String, default: '' }, // sent | delivered | read | failed | received
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const whatsAppAccountSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    wabaId: { type: String, required: true },
    phoneNumberId: { type: String, required: true, index: true },
    displayPhoneNumber: { type: String, default: '' },
    verifiedName: { type: String, default: '' },
    accessToken: { type: String, required: true, select: false },
    status: { type: String, enum: ['connected', 'disconnected'], default: 'connected' },
    lastError: { type: String, default: '' },
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true },
);

/** Keep only the newest 50 messages. */
whatsAppAccountSchema.methods.addMessage = function addMessage(msg) {
  this.messages.push(msg);
  if (this.messages.length > 50) this.messages = this.messages.slice(-50);
};

/** What the website may see (no token). */
whatsAppAccountSchema.methods.toPublic = function toPublic() {
  return {
    wabaId: this.wabaId,
    phoneNumberId: this.phoneNumberId,
    displayPhoneNumber: this.displayPhoneNumber,
    verifiedName: this.verifiedName,
    status: this.status,
    lastError: this.lastError,
    connectedAt: this.createdAt,
    messages: [...this.messages].reverse(),
  };
};

module.exports = mongoose.model('WhatsAppAccount', whatsAppAccountSchema);