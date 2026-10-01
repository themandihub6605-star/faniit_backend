const { mask } = require('./text');

// Shapes documents for API responses so private fields never leak.

function publicStore(store) {
  if (!store) return null;
  return {
    _id: store._id,
    slug: store.slug,
    name: store.name,
    tagline: store.tagline,
    about: store.about,
    logoUrl: store.logoUrl,
    bannerUrl: store.bannerUrl,
    isOpen: store.isOpen,
    creator: store.creator,
    user: store.user,
    stats: { orders: store.stats?.orders || 0 },
    createdAt: store.createdAt,
  };
}

/** The owner's own view: everything except full bank details and KYC keys. */
function ownerStore(store) {
  if (!store) return null;
  const payout = store.payout
    ? {
        method: store.payout.method,
        upiId: store.payout.upiId,
        accountHolderName: store.payout.accountHolderName,
        accountNumberMasked: mask(store.payout.accountNumber),
        ifsc: store.payout.ifsc,
        bankName: store.payout.bankName,
      }
    : null;
  const kyc = store.kyc
    ? {
        status: store.kyc.status,
        panNumberMasked: mask(store.kyc.panNumber),
        panName: store.kyc.panName,
        idType: store.kyc.idType,
        submittedAt: store.kyc.submittedAt,
        reviewedAt: store.kyc.reviewedAt,
        rejectionReason: store.kyc.rejectionReason,
      }
    : null;
  return {
    ...publicStore(store),
    status: store.status,
    statusReason: store.statusReason,
    kycStatus: store.kycStatus,
    hasPayout: store.hasPayout,
    payout,
    kyc,
    termsAcceptedAt: store.termsAcceptedAt,
    termsVersion: store.termsVersion,
    activatedAt: store.activatedAt,
    submittedAt: store.submittedAt,
    stats: store.stats,
    updatedAt: store.updatedAt,
  };
}

function product(p, { owner = false } = {}) {
  if (!p) return null;
  const files = (p.files || []).map((f) => ({ _id: f._id, name: f.name, size: f.size, mimeType: f.mimeType }));
  const base = {
    _id: p._id,
    store: p.store,
    title: p.title,
    description: p.description,
    category: p.category,
    coverUrl: p.coverUrl,
    price: p.price,
    isFree: p.price === 0,
    fileCount: files.length,
    totalSize: files.reduce((sum, f) => sum + (f.size || 0), 0),
    status: p.status,
    publishedAt: p.publishedAt,
    salesCount: p.salesCount,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
  if (!owner) return { ...base, files: files.map(({ _id, name, size, mimeType }) => ({ _id, name, size, mimeType })) };
  return { ...base, files, revenue: p.revenue, views: p.views, removedReason: p.removedReason };
}

function order(o) {
  if (!o) return null;
  return {
    _id: o._id,
    itemType: o.itemType,
    itemId: o.itemId,
    itemTitle: o.itemTitle,
    itemCoverUrl: o.itemCoverUrl,
    message: o.message,
    context: o.context,
    amount: o.amount,
    paidWith: o.paidWith,
    settledAmount: o.settledAmount,
    walletRefund: o.walletRefund,
    feePercent: o.feePercent,
    feeAmount: o.feeAmount,
    creatorEarning: o.creatorEarning,
    status: o.status,
    invoiceNumber: o.invoiceNumber,
    paidAt: o.paidAt,
    refundedAt: o.refundedAt,
    refundReason: o.refundReason,
    createdAt: o.createdAt,
    buyer: o.buyer,
    seller: o.seller,
    store: o.store,
  };
}

module.exports = { publicStore, ownerStore, product, order };
