// File: src/controllers/contact.controller.js
const ContactMessage = require('../models/ContactMessage.model');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** POST /api/contact — public, from the website contact form. */
const createMessage = catchAsync(async (req, res) => {
  const body = req.body || {};
  // Spam trap: real people never fill the hidden "website" field.
  if (clean(body.website, 200)) return new ApiResponse(201, null, 'Message sent').send(res);

  const name = clean(body.name, 80);
  const email = clean(body.email, 120).toLowerCase();
  const phone = clean(body.phone, 20).replace(/[^\d+\s-]/g, '');
  const message = String(body.message ?? '').trim().slice(0, 2000);
  const role = ContactMessage.ROLES.includes(body.role) ? body.role : 'Other';

  if (name.length < 2) throw ApiError.badRequest('Enter your name');
  if (!EMAIL_RX.test(email)) throw ApiError.badRequest('Enter a valid email address');
  if (message.length < 10) throw ApiError.badRequest('Write a little more so we can help — at least 10 characters');

  // Same person sending the same text again within an hour → keep one.
  const dupe = await ContactMessage.findOne({ email, message, createdAt: { $gt: new Date(Date.now() - 60 * 60 * 1000) } }).lean();
  if (!dupe) {
    await ContactMessage.create({
      name,
      email,
      phone,
      role,
      message,
      ip: req.ip || '',
      userAgent: clean(req.get('user-agent'), 300),
    });
  }
  return new ApiResponse(201, null, 'Message sent').send(res);
});

/** GET /api/admin/contact-messages?status=new|read|replied|archived|all&search=&page= */
const listMessages = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const status = String(req.query.status || 'all');
  const search = String(req.query.search || '').trim().slice(0, 100);

  const filter = {};
  if (ContactMessage.STATUSES.includes(status)) filter.status = status;
  else filter.status = { $ne: 'archived' };
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { message: rx }];
  }

  const [messages, total, grouped] = await Promise.all([
    ContactMessage.find(filter).select('-ip -userAgent').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ContactMessage.countDocuments(filter),
    ContactMessage.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const counts = Object.fromEntries(ContactMessage.STATUSES.map((s) => [s, 0]));
  grouped.forEach((g) => {
    counts[g._id] = g.n;
  });

  return new ApiResponse(200, { messages, total, page, pages: Math.max(1, Math.ceil(total / limit)), counts }, 'Contact messages').send(res);
});

/** PATCH /api/admin/contact-messages/:id — { status?, note? } */
const updateMessage = catchAsync(async (req, res) => {
  const update = {};
  if (req.body?.status !== undefined) {
    if (!ContactMessage.STATUSES.includes(req.body.status)) throw ApiError.badRequest('Unknown status');
    update.status = req.body.status;
  }
  if (req.body?.note !== undefined) update.note = clean(req.body.note, 1000);
  if (!Object.keys(update).length) throw ApiError.badRequest('Nothing to update');

  const doc = await ContactMessage.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Message not found');
  Object.assign(doc, update);
  await doc.save();
  const { ip, userAgent, ...msg } = doc.toObject();
  return new ApiResponse(200, msg, 'Message updated').send(res);
});

/** DELETE /api/admin/contact-messages/:id */
const deleteMessage = catchAsync(async (req, res) => {
  const msg = await ContactMessage.findByIdAndDelete(req.params.id);
  if (!msg) throw ApiError.notFound('Message not found');
  return new ApiResponse(200, null, 'Message deleted').send(res);
});

module.exports = { createMessage, listMessages, updateMessage, deleteMessage };