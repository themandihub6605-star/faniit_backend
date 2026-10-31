// File: src/controllers/billing.controller.js
const mongoose = require('mongoose');
const { Invoice } = require('../models');
const billing = require('../services/billing.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

/** GET /api/billing/config — what the app needs: GST, min withdrawal, agreements, my fee. */
const getConfig = catchAsync(async (req, res) => {
  const s = await billing.getSettings();
  const isCreator = req.user.role === 'creator';
  return new ApiResponse(
    200,
    {
      gstEnabled: s.gstEnabled,
      gstPercent: s.gstPercent,
      gstOnBrandPayments: s.gstEnabled && s.gstOnBrandPayments,
      gstOnWithdrawalFee: s.gstEnabled && s.gstOnWithdrawalFee,
      creatorMinWithdrawal: s.creatorMinWithdrawal,
      // Creators only: the fee taken when they withdraw (their plan's %).
      myWithdrawalFeePercent: isCreator ? await billing.creatorFeePercent(req.user) : 0,
      agreementsEnabled: s.agreementsEnabled,
      agreementVersion: s.agreementVersion,
      creatorAgreement: s.agreementsEnabled ? s.creatorAgreementText : '',
      brandAgreement: s.agreementsEnabled ? s.brandAgreementText : '',
    },
    'Billing config'
  ).send(res);
});

/** GET /api/billing/invoices?page= — my invoices, newest first. */
const listMyInvoices = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const filter = { user: req.user._id };
  const [items, total] = await Promise.all([
    Invoice.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Invoice.countDocuments(filter),
  ]);
  return new ApiResponse(200, { invoices: items.map(billing.serialize), total, page, pages: Math.ceil(total / limit) }, 'Invoices fetched').send(res);
});

async function findMine(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Invoice not found');
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) throw ApiError.notFound('Invoice not found');
  if (String(invoice.user) !== String(req.user._id) && req.user.role !== 'admin') throw ApiError.notFound('Invoice not found');
  return invoice;
}

/** GET /api/billing/invoices/:id */
const getInvoice = catchAsync(async (req, res) => {
  const invoice = await findMine(req);
  return new ApiResponse(200, billing.serialize(invoice), 'Invoice fetched').send(res);
});

/** POST /api/billing/invoices/:id/email — send it to my email again. */
const resendInvoice = catchAsync(async (req, res) => {
  const invoice = await findMine(req);
  const ok = await billing.emailInvoice(invoice);
  if (!ok) throw ApiError.badRequest('Couldn’t send the email right now. Please try again in a bit.');
  return new ApiResponse(200, null, `Invoice sent to ${invoice.billedTo?.email || 'your email'}`).send(res);
});

// --- admin -------------------------------------------------------------------------

/** GET /api/billing/admin/settings */
const adminGetSettings = catchAsync(async (req, res) => {
  const s = await billing.getSettings({ fresh: true });
  return new ApiResponse(200, s, 'Billing settings').send(res);
});

/** PATCH /api/billing/admin/settings */
const adminUpdateSettings = catchAsync(async (req, res) => {
  const s = await billing.updateSettings(req.body || {});
  return new ApiResponse(200, s, 'Billing settings saved').send(res);
});

/** GET /api/billing/admin/invoices?kind=&q=&page= — every invoice issued. */
const adminListInvoices = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const filter = {};
  if (Invoice.KINDS.includes(req.query.kind)) filter.kind = req.query.kind;
  const q = String(req.query.q || '').trim();
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ number: rx }, { 'billedTo.name': rx }, { 'billedTo.email': rx }];
  }
  const [items, total, sums] = await Promise.all([
    Invoice.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Invoice.countDocuments(filter),
    Invoice.find({ ...filter, status: 'issued' }).select('subtotal gstAmount kind'),
  ]);
  const totals = sums.reduce(
    (t, i) => {
      if (i.kind === 'withdrawal_fee') t.platformFees += i.subtotal;
      t.gst += i.gstAmount;
      return t;
    },
    { platformFees: 0, gst: 0 }
  );
  return new ApiResponse(200, { invoices: items.map(billing.serialize), total, page, pages: Math.ceil(total / limit), totals }, 'Invoices fetched').send(res);
});

module.exports = { getConfig, listMyInvoices, getInvoice, resendInvoice, adminGetSettings, adminUpdateSettings, adminListInvoices };
