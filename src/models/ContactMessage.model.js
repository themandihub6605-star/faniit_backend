// File: src/models/ContactMessage.model.js
const mongoose = require('mongoose');

// Messages sent from the "Contact" form on the website. Admins read and
// answer them from the admin panel (Contact messages).
const ROLES = ['Creator', 'Brand', 'Fan', 'Agency', 'Other'];
const STATUSES = ['new', 'read', 'replied', 'archived'];

const contactMessageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 20, default: '' },
    role: { type: String, enum: ROLES, default: 'Other' },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    status: { type: String, enum: STATUSES, default: 'new', index: true },
    note: { type: String, trim: true, maxlength: 1000, default: '' }, // admin-only note
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true, collection: 'contactmessages' }
);
contactMessageSchema.index({ createdAt: -1 });

contactMessageSchema.statics.ROLES = ROLES;
contactMessageSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.models.ContactMessage || mongoose.model('ContactMessage', contactMessageSchema);