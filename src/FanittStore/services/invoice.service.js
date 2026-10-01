const { StoreCounter } = require('../models');
const { formatRupees } = require('../utils/money');

// Invoice numbers: FS-<year>-<6 digits>, one sequence per year.
async function nextInvoiceNumber(date = new Date()) {
  const year = date.getFullYear();
  const seq = await StoreCounter.next(`invoice-${year}`);
  return `FS-${year}-${String(seq).padStart(6, '0')}`;
}

/** Everything an invoice shows. `order` must have buyer, seller and store populated. */
function buildInvoice(order) {
  return {
    invoiceNumber: order.invoiceNumber,
    date: order.paidAt || order.createdAt,
    status: order.status,
    seller: { name: order.store?.name || order.seller?.name || '', storeSlug: order.store?.slug || '' },
    buyer: { name: order.buyer?.name || '', email: order.buyer?.email || '' },
    item: { type: order.itemType, title: order.itemTitle },
    amount: order.amount,
    paymentId: order.razorpayPaymentId,
    platform: { name: 'Fanitt', website: 'https://fanitt.com' },
    refundedAt: order.refundedAt,
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Printable invoice page (open in a browser and "Save as PDF"). */
function renderInvoiceHtml(inv) {
  const date = new Date(inv.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice ${escapeHtml(inv.invoiceNumber)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#1b1b1f;margin:0;padding:24px;background:#f4f4f6}
  .card{max-width:720px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;box-shadow:0 4px 24px rgba(0,0,0,.06)}
  .top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
  .brand{font-size:26px;font-weight:800;color:#F4511E}
  h2{margin:0 0 4px;font-size:18px} .muted{color:#6b6b76;font-size:13px}
  table{width:100%;border-collapse:collapse;margin-top:24px} th,td{text-align:left;padding:12px 8px;border-bottom:1px solid #eee;font-size:14px}
  th{color:#6b6b76;font-weight:600} .total td{font-weight:800;font-size:16px;border-bottom:none}
  .tag{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700;background:${inv.status === 'refunded' ? '#fde2e2' : '#dcfce7'};color:${inv.status === 'refunded' ? '#b91c1c' : '#15803d'}}
  @media print{body{background:#fff;padding:0}.card{box-shadow:none}}
</style></head>
<body><div class="card">
  <div class="top">
    <div><div class="brand">Fanitt</div><div class="muted">Fanitt Store</div></div>
    <div style="text-align:right"><h2>Invoice</h2><div class="muted">${escapeHtml(inv.invoiceNumber)}</div><div class="muted">${escapeHtml(date)}</div>
    <div style="margin-top:6px"><span class="tag">${inv.status === 'refunded' ? 'REFUNDED' : 'PAID'}</span></div></div>
  </div>
  <div class="top" style="margin-top:24px">
    <div><div class="muted">Sold by</div><strong>${escapeHtml(inv.seller.name)}</strong></div>
    <div style="text-align:right"><div class="muted">Billed to</div><strong>${escapeHtml(inv.buyer.name)}</strong><div class="muted">${escapeHtml(inv.buyer.email)}</div></div>
  </div>
  <table><thead><tr><th>Item</th><th style="text-align:right">Amount</th></tr></thead>
  <tbody><tr><td>${escapeHtml(inv.item.title)}</td><td style="text-align:right">${escapeHtml(formatRupees(inv.amount))}</td></tr>
  <tr class="total"><td>Total paid</td><td style="text-align:right">${escapeHtml(formatRupees(inv.amount))}</td></tr></tbody></table>
  <p class="muted" style="margin-top:24px">Payment ID: ${escapeHtml(inv.paymentId || '—')}<br>This is a computer-generated invoice from Fanitt.</p>
</div></body></html>`;
}

module.exports = { nextInvoiceNumber, buildInvoice, renderInvoiceHtml };
