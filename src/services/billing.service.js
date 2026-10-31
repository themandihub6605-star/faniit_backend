// File: src/services/billing.service.js
//
// One place for Fanitt's money rules (all amounts in paise):
//   • Platform fee is taken ONLY when a creator withdraws — the creator's plan
//     fee % (Lite / Pro…), with GST on that fee. Brands, agencies and fans
//     withdraw without a fee.
//   • Creators must withdraw at least creatorMinWithdrawal.
//   • Brands pay GST on top when they pay for a campaign / milestone.
//   • Every GST payment gets a tax invoice (in the app + emailed).
//   • Creator / brand agreements — the text they tick, frozen with a version.
// Everything is switched / changed from Admin → Billing & GST.

const { BillingSettings, Invoice, User } = require('../models');
const { sendEmail, escapeHtml } = require('./email.service');
const ApiError = require('../utils/apiError');

// --- settings ----------------------------------------------------------------

const CACHE_MS = 15 * 1000;
let cached = null;
let cachedAt = 0;

async function getSettings({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < CACHE_MS) return cached;
  cached = await BillingSettings.getSingleton();
  cachedAt = Date.now();
  return cached;
}

function clearCache() {
  cached = null;
  cachedAt = 0;
}

const NUMBER_FIELDS = {
  gstPercent: [0, 50],
  creatorMinWithdrawal: [0, 100000000],
  defaultCreatorFeePercent: [0, 100],
};
const BOOL_FIELDS = ['gstEnabled', 'gstOnWithdrawalFee', 'gstOnBrandPayments', 'agreementsEnabled'];
const TEXT_FIELDS = {
  invoicePrefix: 10,
  businessName: 120,
  businessGstin: 20,
  businessAddress: 400,
  businessEmail: 120,
  creatorAgreementText: 4000,
  brandAgreementText: 4000,
};

/** Admin update — only known fields; agreement version goes up when a text changes. */
async function updateSettings(body = {}) {
  const s = await BillingSettings.getSingleton();
  for (const [key, [min, max]] of Object.entries(NUMBER_FIELDS)) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < min || n > max) throw ApiError.badRequest(`${key} must be between ${min} and ${max}`);
    s[key] = key === 'creatorMinWithdrawal' ? Math.round(n) : n;
  }
  for (const key of BOOL_FIELDS) {
    if (body[key] !== undefined) s[key] = body[key] === true || body[key] === 'true';
  }
  let agreementChanged = false;
  for (const [key, max] of Object.entries(TEXT_FIELDS)) {
    if (body[key] === undefined) continue;
    const value = String(body[key] ?? '').trim();
    if (value.length > max) throw ApiError.badRequest(`${key} can be up to ${max} characters`);
    if ((key === 'creatorAgreementText' || key === 'brandAgreementText') && !value) {
      throw ApiError.badRequest('Agreement text can’t be empty');
    }
    if ((key === 'creatorAgreementText' || key === 'brandAgreementText') && value !== s[key]) agreementChanged = true;
    s[key] = key === 'invoicePrefix' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'FAN' : value;
  }
  if (agreementChanged) s.agreementVersion = (s.agreementVersion || 1) + 1;
  await s.save();
  clearCache();
  return s;
}

// --- GST & fees ----------------------------------------------------------------

const percentOf = (amount, percent) => Math.round((Number(amount) * Number(percent)) / 100);

/** What a brand pays for [base]: base + GST (if on). */
async function brandPaymentBreakdown(base) {
  const s = await getSettings();
  const gstPercent = s.gstEnabled && s.gstOnBrandPayments ? s.gstPercent : 0;
  const gstAmount = percentOf(base, gstPercent);
  return { base, gstPercent, gstAmount, total: base + gstAmount };
}

/** The creator's plan fee %, or the admin's fallback. */
async function creatorFeePercent(user) {
  try {
    // Lazy require — subscription.service pulls in wallet.service.
    const { getCreatorPlanFields } = require('./subscription.service');
    const plan = await getCreatorPlanFields(user._id);
    if (plan?.platformFeePercent != null) return plan.platformFeePercent;
  } catch {
    // fall back below
  }
  const s = await getSettings();
  return s.defaultCreatorFeePercent;
}

/**
 * Fee, GST and payout for a withdrawal of [amount].
 * Only creators pay a fee. [feeExempt] = part of the balance that already
 * paid a fee before this rule (old store sales) or is the user's own refund.
 */
async function withdrawalBreakdown(user, amount, { feeExempt = 0 } = {}) {
  const s = await getSettings();
  if (user.role !== 'creator') {
    return { amount, isCreator: false, minWithdrawal: 100, platformFeePercent: 0, platformFee: 0, gstPercent: 0, gstAmount: 0, netPayoutAmount: amount, feeExemptUsed: 0 };
  }
  const platformFeePercent = await creatorFeePercent(user);
  const feeExemptUsed = Math.min(amount, Math.max(0, feeExempt || 0));
  const platformFee = percentOf(amount - feeExemptUsed, platformFeePercent);
  const gstPercent = s.gstEnabled && s.gstOnWithdrawalFee && platformFee > 0 ? s.gstPercent : 0;
  const gstAmount = percentOf(platformFee, gstPercent);
  return {
    amount,
    isCreator: true,
    minWithdrawal: s.creatorMinWithdrawal,
    platformFeePercent,
    platformFee,
    gstPercent,
    gstAmount,
    netPayoutAmount: Math.max(0, amount - platformFee - gstAmount),
    feeExemptUsed,
  };
}

// --- agreements -----------------------------------------------------------------

/** Text + version a party must accept, or null when agreements are off. */
async function agreementFor(party) {
  const s = await getSettings();
  if (!s.agreementsEnabled) return null;
  return { version: s.agreementVersion, text: party === 'creator' ? s.creatorAgreementText : s.brandAgreementText };
}

/**
 * Checks the box was ticked and returns the snapshot to save
 * ({ acceptedAt, version, text }) — or null when agreements are off.
 */
async function acceptAgreement(party, accepted) {
  const current = await agreementFor(party);
  if (!current) return null;
  if (accepted !== true && accepted !== 'true') {
    throw ApiError.badRequest('Please read and accept the agreement to continue', [], 'AGREEMENT_REQUIRED');
  }
  return { acceptedAt: new Date(), version: current.version, text: current.text };
}

// --- invoices -------------------------------------------------------------------

/** FAN/2026-27/000001 — one sequence per financial year (April–March). */
async function nextInvoiceNumber(prefix, date = new Date()) {
  const { StoreCounter } = require('../FanittStore/models');
  const fy = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  const fyLabel = `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`;
  const seq = await StoreCounter.next(`invoice-${prefix}-${fyLabel}`);
  return `${prefix}/${fyLabel}/${String(seq).padStart(6, '0')}`;
}

const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function serialize(inv) {
  const o = inv.toObject ? inv.toObject() : inv;
  return {
    _id: o._id,
    number: o.number,
    kind: o.kind,
    title: o.title,
    billedTo: o.billedTo,
    seller: o.seller,
    lines: o.lines,
    subtotal: o.subtotal,
    gstPercent: o.gstPercent,
    gstAmount: o.gstAmount,
    total: o.total,
    withdrawalAmount: o.withdrawalAmount,
    payoutAmount: o.payoutAmount,
    status: o.status,
    relatedModel: o.relatedModel,
    relatedId: o.relatedId,
    razorpayPaymentId: o.razorpayPaymentId,
    emailedAt: o.emailedAt,
    createdAt: o.createdAt,
  };
}

function renderInvoiceHtml(inv) {
  const date = new Date(inv.createdAt || Date.now()).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const rows = (inv.lines || [])
    .map((l) => `<tr><td style="padding:10px 0;border-bottom:1px solid #eee">${escapeHtml(l.label)}</td><td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right">${rupees(l.amount)}</td></tr>`)
    .join('');
  const gstRow = inv.gstAmount > 0
    ? `<tr><td style="padding:10px 0;border-bottom:1px solid #eee">GST @ ${inv.gstPercent}%</td><td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right">${rupees(inv.gstAmount)}</td></tr>`
    : '';
  const payout = inv.kind === 'withdrawal_fee' && inv.withdrawalAmount != null
    ? `<p style="font-size:13px;color:#555;margin:16px 0 0">Withdrawn: <b>${rupees(inv.withdrawalAmount)}</b> · Paid to you: <b>${rupees(inv.payoutAmount)}</b></p>`
    : '';
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div style="font-size:24px;font-weight:800;color:#F4511E">${escapeHtml(inv.seller?.name || 'Fanitt')}</div>
        ${inv.seller?.address ? `<div style="font-size:12px;color:#666;white-space:pre-line">${escapeHtml(inv.seller.address)}</div>` : ''}
        ${inv.seller?.gstin ? `<div style="font-size:12px;color:#666">GSTIN: ${escapeHtml(inv.seller.gstin)}</div>` : ''}
      </div>
    </div>
    <h2 style="margin:24px 0 4px;font-size:18px">Tax invoice</h2>
    <div style="font-size:13px;color:#666">${escapeHtml(inv.number)} · ${escapeHtml(date)}</div>
    <div style="margin-top:16px;font-size:13px;color:#666">Billed to</div>
    <div style="font-weight:700">${escapeHtml(inv.billedTo?.name || '')}</div>
    <div style="font-size:13px;color:#666">${escapeHtml(inv.billedTo?.email || '')}</div>
    <p style="margin:20px 0 4px;font-weight:700">${escapeHtml(inv.title)}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      ${rows}
      ${gstRow}
      <tr><td style="padding:12px 0;font-weight:800">Total</td><td style="padding:12px 0;font-weight:800;text-align:right">${rupees(inv.total)}</td></tr>
    </table>
    ${payout}
    ${inv.razorpayPaymentId ? `<p style="font-size:12px;color:#888;margin-top:12px">Payment ID: ${escapeHtml(inv.razorpayPaymentId)}</p>` : ''}
    <p style="font-size:12px;color:#888;margin-top:24px">You can also find this invoice in the Fanitt app under Wallet → Invoices.</p>
    <p style="font-size:12px;color:#888">— Team Fanitt</p>
  </div>`;
}

/** Emails an invoice to the person it's billed to. Never throws. */
async function emailInvoice(invoice) {
  try {
    const to = invoice.billedTo?.email;
    if (!to) return false;
    const ok = await sendEmail({ to, subject: `Your Fanitt invoice ${invoice.number}`, html: renderInvoiceHtml(invoice) });
    if (ok) await Invoice.updateOne({ _id: invoice._id }, { $set: { emailedAt: new Date() } });
    return ok;
  } catch (err) {
    console.error('[billing] invoice email failed:', err.message);
    return false;
  }
}

/**
 * Creates the invoice for a paid thing exactly once (returns the existing one
 * on repeat calls) and emails it. Never throws — a failed invoice must not
 * undo a payment that already went through.
 */
async function issueInvoice({ userId, kind, title, lines, subtotal, gstPercent = 0, gstAmount = 0, withdrawalAmount = null, payoutAmount = null, relatedModel, relatedId, razorpayPaymentId = '' }) {
  try {
    const existing = await Invoice.findOne({ relatedModel, relatedId, kind });
    if (existing) return existing;

    const [s, user] = await Promise.all([getSettings(), User.findById(userId).select('name email')]);
    const invoice = await Invoice.create({
      number: await nextInvoiceNumber(s.invoicePrefix || 'FAN'),
      user: userId,
      kind,
      title,
      billedTo: { name: user?.name || '', email: user?.email || '' },
      seller: { name: s.businessName || 'Fanitt', gstin: s.businessGstin || '', address: s.businessAddress || '', email: s.businessEmail || '' },
      lines,
      subtotal,
      gstPercent,
      gstAmount,
      total: subtotal + gstAmount,
      withdrawalAmount,
      payoutAmount,
      relatedModel,
      relatedId,
      razorpayPaymentId,
    });
    emailInvoice(invoice);
    return invoice;
  } catch (err) {
    if (err?.code === 11000) return Invoice.findOne({ relatedModel, relatedId, kind });
    console.error('[billing] invoice failed:', err.message, { relatedModel, relatedId: String(relatedId) });
    return null;
  }
}

/** Brand paid [base] + GST for a campaign or milestone. */
async function issueBrandPaymentInvoice({ brandUserId, relatedModel, relatedId, title, lineLabel, base, gstPercent, gstAmount, razorpayPaymentId }) {
  return issueInvoice({
    userId: brandUserId,
    kind: 'brand_payment',
    title,
    lines: [{ label: lineLabel, amount: base }],
    subtotal: base,
    gstPercent,
    gstAmount,
    relatedModel,
    relatedId,
    razorpayPaymentId,
  });
}

/** Creator's withdrawal was paid — invoice for Fanitt's fee (+ GST). */
async function issueWithdrawalInvoice(withdrawal) {
  if (!withdrawal || !(withdrawal.platformFee > 0)) return null;
  const userId = withdrawal.user?._id || withdrawal.user;
  const invoice = await issueInvoice({
    userId,
    kind: 'withdrawal_fee',
    title: 'Fanitt platform fee on withdrawal',
    lines: [{ label: `Platform fee (${withdrawal.platformFeePercent}%) on ${rupees(withdrawal.amount)} withdrawal`, amount: withdrawal.platformFee }],
    subtotal: withdrawal.platformFee,
    gstPercent: withdrawal.gstPercent || 0,
    gstAmount: withdrawal.gstAmount || 0,
    withdrawalAmount: withdrawal.amount,
    payoutAmount: withdrawal.netPayoutAmount,
    relatedModel: 'Withdrawal',
    relatedId: withdrawal._id,
  });
  if (invoice && !withdrawal.invoice) {
    const { Withdrawal } = require('../models');
    await Withdrawal.updateOne({ _id: withdrawal._id }, { $set: { invoice: invoice._id } });
  }
  return invoice;
}

module.exports = {
  getSettings,
  updateSettings,
  clearCache,
  brandPaymentBreakdown,
  creatorFeePercent,
  withdrawalBreakdown,
  agreementFor,
  acceptAgreement,
  issueBrandPaymentInvoice,
  issueWithdrawalInvoice,
  emailInvoice,
  renderInvoiceHtml,
  serialize,
};
