const mongoose = require('mongoose');
const { User } = require('../../models');
const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const ApiError = require('../../utils/apiError');
const { Store, DigitalProduct, StoreOrder, LiveStream, CallSession, AffiliateProduct } = require('../models');
const { STORE_STATUS, KYC_STATUS, PRODUCT_STATUS, ORDER_STATUS, TOOL_KEYS, LIVE_STATUS, CALL_STATUS, AFFILIATE_STATUS, ORDER_ITEM } = require('../constants');
const settingsService = require('../services/settings.service');
const orderService = require('../services/order.service');
const liveService = require('../services/live.service');
const callService = require('../services/call.service');
const storage = require('../services/storage.service');
const { alertUser } = require('../../services/alert.service');

// Every admin decision on a creator's store reaches them in-app, by push
// and by email.
const safeNotify = (payload) => alertUser({ ...payload, email: payload.email ?? true });
const { ownerStore, product: serializeProduct, order: serializeOrder } = require('../utils/serialize');
const { pageParams, escapeRegex } = require('../utils/text');
const log = require('../utils/logger');

// Admin panel: review stores, moderate products, refund orders, settings.

function assertObjectId(id, label) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound(`${label} not found`);
}

async function userIdsMatching(search) {
  const pattern = new RegExp(escapeRegex(search), 'i');
  const users = await User.find({ $or: [{ name: pattern }, { email: pattern }] }).select('_id').limit(300);
  return users.map((u) => u._id);
}

/** GET /api/store/admin/overview */
const getOverview = catchAsync(async (req, res) => {
  const [storeCounts, pendingKyc, productCounts, sales, liveCounts, callCounts] = await Promise.all([
    Store.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Store.countDocuments({ kycStatus: KYC_STATUS.PENDING }),
    DigitalProduct.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    StoreOrder.aggregate([
      { $match: { status: { $in: [ORDER_STATUS.PAID, ORDER_STATUS.REFUNDED] } } },
      {
        $group: {
          _id: '$status',
          orders: { $sum: 1 },
          gross: { $sum: '$amount' },
          fees: { $sum: '$feeAmount' },
          creatorEarnings: { $sum: '$creatorEarning' },
        },
      },
    ]),
    LiveStream.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    CallSession.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, billed: { $sum: '$billedAmount' }, minutes: { $sum: '$billedMinutes' } } }]),
  ]);
  const toMap = (rows) => Object.fromEntries(rows.map((r) => [r._id, r.count]));
  const paid = sales.find((s) => s._id === ORDER_STATUS.PAID) || { orders: 0, gross: 0, fees: 0, creatorEarnings: 0 };
  const refunded = sales.find((s) => s._id === ORDER_STATUS.REFUNDED) || { orders: 0, gross: 0 };
  return new ApiResponse(
    200,
    {
      stores: toMap(storeCounts),
      pendingKyc,
      products: toMap(productCounts),
      sales: {
        orders: paid.orders,
        gross: paid.gross,
        fees: paid.fees,
        creatorEarnings: paid.creatorEarnings,
        refundedOrders: refunded.orders,
        refundedAmount: refunded.gross,
      },
      lives: toMap(liveCounts),
      calls: {
        byStatus: toMap(callCounts),
        billedAmount: callCounts.reduce((sum, c) => sum + (c.billed || 0), 0),
        billedMinutes: callCounts.reduce((sum, c) => sum + (c.minutes || 0), 0),
      },
    },
    'Overview'
  ).send(res);
});

/** GET /api/store/admin/stores?status=&kyc=&search=&page= */
const listStores = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = {};
  if (Object.values(STORE_STATUS).includes(req.query.status)) filter.status = req.query.status;
  if (Object.values(KYC_STATUS).includes(req.query.kyc)) filter.kycStatus = req.query.kyc;
  const search = String(req.query.search || '').trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: pattern }, { slug: pattern }, { user: { $in: await userIdsMatching(search) } }];
  }
  const [stores, total] = await Promise.all([
    Store.find(filter).populate('user', 'name email phone avatarUrl').sort({ submittedAt: -1, createdAt: -1 }).skip(skip).limit(limit),
    Store.countDocuments(filter),
  ]);
  return new ApiResponse(
    200,
    {
      stores: stores.map((s) => ({ ...ownerStore(s), user: s.user })),
      total,
      page,
      pages: Math.ceil(total / limit),
    },
    'Stores fetched'
  ).send(res);
});

/** GET /api/store/admin/stores/:id — full details incl. KYC docs (signed links) and payout. */
const getStore = catchAsync(async (req, res) => {
  assertObjectId(req.params.id, 'Store');
  const store = await Store.findById(req.params.id).select('+payout +kyc').populate('user', 'name email phone avatarUrl createdAt');
  if (!store) throw ApiError.notFound('Store not found');

  const docs = {};
  if (store.kyc?.panDocumentKey) docs.pan = (await storage.presignDownload(store.kyc.panDocumentKey, 'pan', { inline: true })).url;
  if (store.kyc?.idDocumentKey) docs.id = (await storage.presignDownload(store.kyc.idDocumentKey, 'id-proof', { inline: true })).url;

  const [products, recentOrders] = await Promise.all([
    DigitalProduct.find({ store: store._id }).sort({ createdAt: -1 }).limit(50),
    StoreOrder.find({ store: store._id, status: { $in: [ORDER_STATUS.PAID, ORDER_STATUS.REFUNDED] } })
      .populate('buyer', 'name email')
      .sort({ paidAt: -1 })
      .limit(20),
  ]);

  return new ApiResponse(
    200,
    {
      store: { ...ownerStore(store), user: store.user },
      // Admin sees full payout + KYC numbers to verify them.
      payout: store.payout || null,
      kyc: store.kyc
        ? {
            status: store.kyc.status,
            panNumber: store.kyc.panNumber,
            panName: store.kyc.panName,
            idType: store.kyc.idType,
            submittedAt: store.kyc.submittedAt,
            reviewedAt: store.kyc.reviewedAt,
            rejectionReason: store.kyc.rejectionReason,
            documents: docs,
          }
        : null,
      products: products.map((p) => serializeProduct(p, { owner: true })),
      recentOrders: recentOrders.map(serializeOrder),
    },
    'Store fetched'
  ).send(res);
});

/** PATCH /api/store/admin/stores/:id/kyc  { decision: approve | reject, reason? } */
const reviewKyc = catchAsync(async (req, res) => {
  assertObjectId(req.params.id, 'Store');
  const store = await Store.findById(req.params.id).select('+kyc');
  if (!store) throw ApiError.notFound('Store not found');
  if (store.kycStatus !== KYC_STATUS.PENDING) throw ApiError.badRequest('This store has no KYC waiting for review');

  const approve = req.body.decision === 'approve';
  store.kyc.status = approve ? KYC_STATUS.VERIFIED : KYC_STATUS.REJECTED;
  store.kyc.reviewedAt = new Date();
  store.kyc.reviewedBy = req.user._id;
  store.kyc.rejectionReason = approve ? '' : req.body.reason;
  store.kycStatus = store.kyc.status;

  if (approve) {
    // Active only if every other step is done too (normally yes — review
    // starts after all four steps).
    const ready = store.name && store.hasPayout && store.termsAcceptedAt;
    if (store.status !== STORE_STATUS.SUSPENDED) {
      store.status = ready ? STORE_STATUS.ACTIVE : STORE_STATUS.DRAFT;
      if (ready) store.activatedAt = store.activatedAt || new Date();
    }
    store.statusReason = '';
  } else {
    store.status = STORE_STATUS.REJECTED;
    store.statusReason = req.body.reason;
  }
  await store.save();
  log.info('admin.kyc_reviewed', { storeId: String(store._id), decision: req.body.decision, adminId: String(req.user._id) });

  await safeNotify({
    userId: store.user,
    fromUser: req.user._id,
    type: 'store_update',
    title: approve ? 'Your Fanitt Store is live 🎉' : 'KYC needs another look',
    message: approve ? 'KYC approved — you can start adding products and selling.' : `Your KYC wasn't approved: ${req.body.reason}. Update it and submit again.`,
    relatedModel: 'Store',
    relatedId: store._id,
  });

  return new ApiResponse(200, ownerStore(store), approve ? 'KYC approved' : 'KYC rejected').send(res);
});

/** PATCH /api/store/admin/stores/:id/status  { action: suspend (reason) | reinstate } */
const setStoreStatus = catchAsync(async (req, res) => {
  assertObjectId(req.params.id, 'Store');
  const store = await Store.findById(req.params.id);
  if (!store) throw ApiError.notFound('Store not found');

  if (req.body.action === 'suspend') {
    if (store.status === STORE_STATUS.SUSPENDED) throw ApiError.badRequest('Store is already suspended');
    store.status = STORE_STATUS.SUSPENDED;
    store.statusReason = req.body.reason;
  } else {
    if (store.status !== STORE_STATUS.SUSPENDED) throw ApiError.badRequest('Store is not suspended');
    store.status = store.kycStatus === KYC_STATUS.VERIFIED ? STORE_STATUS.ACTIVE : STORE_STATUS.DRAFT;
    store.statusReason = '';
  }
  await store.save();
  log.info('admin.store_status', { storeId: String(store._id), action: req.body.action, adminId: String(req.user._id) });

  await safeNotify({
    userId: store.user,
    fromUser: req.user._id,
    type: 'store_update',
    title: req.body.action === 'suspend' ? 'Your store was suspended' : 'Your store is back',
    message: req.body.action === 'suspend' ? `Reason: ${req.body.reason}` : 'Your Fanitt Store has been reinstated.',
    relatedModel: 'Store',
    relatedId: store._id,
  });
  return new ApiResponse(200, ownerStore(store), 'Store updated').send(res);
});

/** GET /api/store/admin/products?status=&search=&page= */
const listProducts = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = {};
  if (Object.values(PRODUCT_STATUS).includes(req.query.status)) filter.status = req.query.status;
  const search = String(req.query.search || '').trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ title: pattern }, { owner: { $in: await userIdsMatching(search) } }];
  }
  const [products, total] = await Promise.all([
    DigitalProduct.find(filter)
      .populate('owner', 'name email')
      .populate('store', 'name slug')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    DigitalProduct.countDocuments(filter),
  ]);
  return new ApiResponse(
    200,
    {
      products: products.map((p) => ({ ...serializeProduct(p, { owner: true }), owner: p.owner, store: p.store })),
      total,
      page,
      pages: Math.ceil(total / limit),
    },
    'Products fetched'
  ).send(res);
});

/** PATCH /api/store/admin/products/:id/remove { reason } */
const removeProduct = catchAsync(async (req, res) => {
  assertObjectId(req.params.id, 'Product');
  const product = await DigitalProduct.findById(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');
  if (product.status === PRODUCT_STATUS.REMOVED) throw ApiError.badRequest('Product is already removed');
  product.status = PRODUCT_STATUS.REMOVED;
  product.removedReason = req.body.reason;
  product.removedAt = new Date();
  await product.save();
  log.info('admin.product_removed', { productId: String(product._id), adminId: String(req.user._id) });
  await safeNotify({
    userId: product.owner,
    fromUser: req.user._id,
    type: 'store_update',
    title: 'A product was removed',
    message: `"${product.title}" was taken down: ${req.body.reason}`,
    relatedModel: 'DigitalProduct',
    relatedId: product._id,
  });
  return new ApiResponse(200, serializeProduct(product, { owner: true }), 'Product removed').send(res);
});

/** PATCH /api/store/admin/products/:id/restore — back to unpublished; creator republishes. */
const restoreProduct = catchAsync(async (req, res) => {
  assertObjectId(req.params.id, 'Product');
  const product = await DigitalProduct.findById(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');
  if (product.status !== PRODUCT_STATUS.REMOVED) throw ApiError.badRequest('Product is not removed');
  product.status = PRODUCT_STATUS.UNPUBLISHED;
  product.removedReason = '';
  product.removedAt = null;
  await product.save();
  return new ApiResponse(200, serializeProduct(product, { owner: true }), 'Product restored').send(res);
});

/** GET /api/store/admin/orders?status=&search=&page= */
const listOrders = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = {};
  if (Object.values(ORDER_STATUS).includes(req.query.status)) filter.status = req.query.status;
  const search = String(req.query.search || '').trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    const ids = await userIdsMatching(search);
    filter.$or = [
      { itemTitle: pattern },
      { invoiceNumber: pattern },
      { razorpayPaymentId: pattern },
      { buyer: { $in: ids } },
      { seller: { $in: ids } },
    ];
  }
  const [orders, total] = await Promise.all([
    StoreOrder.find(filter)
      .populate('buyer', 'name email')
      .populate('seller', 'name email')
      .populate('store', 'name slug')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    StoreOrder.countDocuments(filter),
  ]);
  return new ApiResponse(
    200,
    {
      orders: orders.map((o) => ({ ...serializeOrder(o), razorpayPaymentId: o.razorpayPaymentId, razorpayRefundId: o.razorpayRefundId })),
      total,
      page,
      pages: Math.ceil(total / limit),
    },
    'Orders fetched'
  ).send(res);
});

/** POST /api/store/admin/orders/:id/refund { reason } */
const refundOrder = catchAsync(async (req, res) => {
  assertObjectId(req.params.id, 'Order');
  const order = await orderService.refundOrder(req.params.id, { byUserId: req.user._id, reason: req.body.reason });
  return new ApiResponse(200, serializeOrder(order), 'Order refunded').send(res);
});

/** GET /api/store/admin/settings */
const getSettings = catchAsync(async (req, res) => {
  const settings = await settingsService.getSettings({ fresh: true });
  return new ApiResponse(200, settings, 'Settings').send(res);
});

/** PATCH /api/store/admin/settings — fees and terms. */
const updateSettings = catchAsync(async (req, res) => {
  const settings = await settingsService.getSettings({ fresh: true });
  ['storeFeePercent', 'fanboxFeePercent', 'requireSubscription', 'termsVersion', 'termsText'].forEach((field) => {
    if (req.body[field] !== undefined) settings[field] = req.body[field];
  });
  settings.updatedBy = req.user._id;
  await settings.save();
  settingsService.invalidate();
  log.info('admin.settings_updated', { adminId: String(req.user._id), fields: Object.keys(req.body) });
  return new ApiResponse(200, settings, 'Settings saved').send(res);
});

function findCard(settings, key) {
  if (!TOOL_KEYS.includes(key)) throw ApiError.notFound('Tool card not found');
  const card = settings.toolCards.find((c) => c.key === key);
  if (!card) throw ApiError.notFound('Tool card not found');
  return card;
}

/** PATCH /api/store/admin/tool-cards/:key — title, description, enabled, order. */
const updateToolCard = catchAsync(async (req, res) => {
  const settings = await settingsService.getSettings({ fresh: true });
  const card = findCard(settings, req.params.key);
  ['title', 'description', 'enabled', 'order'].forEach((field) => {
    if (req.body[field] !== undefined) card[field] = req.body[field];
  });
  settings.updatedBy = req.user._id;
  await settings.save();
  settingsService.invalidate();
  return new ApiResponse(200, settings.toolCards, 'Card saved').send(res);
});

/** POST /api/store/admin/tool-cards/:key/image (multipart "image") */
const uploadToolCardImage = catchAsync(async (req, res) => {
  if (!req.file?.path) throw ApiError.badRequest('Choose an image');
  const settings = await settingsService.getSettings({ fresh: true });
  const card = findCard(settings, req.params.key);
  card.imageUrl = req.file.path;
  settings.updatedBy = req.user._id;
  await settings.save();
  settingsService.invalidate();
  return new ApiResponse(200, settings.toolCards, 'Image saved').send(res);
});

/** PATCH /api/store/admin/banner — website banner text/links/on-off. */
const updateBanner = catchAsync(async (req, res) => {
  const settings = await settingsService.getSettings({ fresh: true });
  const willBeEnabled = req.body.enabled ?? settings.webBanner.enabled;
  const imageUrl = req.body.imageUrl ?? settings.webBanner.imageUrl;
  if (willBeEnabled && !imageUrl) throw ApiError.badRequest('Upload a banner image before turning the banner on');
  Object.entries(req.body).forEach(([field, value]) => {
    settings.webBanner[field] = value;
  });
  settings.updatedBy = req.user._id;
  await settings.save();
  settingsService.invalidate();
  return new ApiResponse(200, settings.webBanner, 'Banner saved').send(res);
});

/** POST /api/store/admin/banner/image (multipart "image") */
const uploadBannerImage = catchAsync(async (req, res) => {
  if (!req.file?.path) throw ApiError.badRequest('Choose an image');
  const settings = await settingsService.getSettings({ fresh: true });
  settings.webBanner.imageUrl = req.file.path;
  settings.updatedBy = req.user._id;
  await settings.save();
  settingsService.invalidate();
  return new ApiResponse(200, settings.webBanner, 'Banner image saved').send(res);
});

/** GET /api/store/admin/lives?status=&page= */
const listLives = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = {};
  if (Object.values(LIVE_STATUS).includes(req.query.status)) filter.status = req.query.status;
  const [lives, total] = await Promise.all([
    LiveStream.find(filter)
      .populate('host', 'name email')
      .populate('store', 'name slug')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    LiveStream.countDocuments(filter),
  ]);
  return new ApiResponse(
    200,
    {
      lives: lives.map((l) => ({
        _id: l._id,
        title: l.title,
        coverUrl: l.coverUrl,
        status: l.status,
        visibility: l.visibility,
        privateMode: l.privateMode,
        price: l.price,
        scheduledAt: l.scheduledAt,
        startedAt: l.startedAt,
        endedAt: l.endedAt,
        stats: l.stats,
        host: l.host,
        store: l.store,
        endedByAdmin: l.endedByAdmin,
        createdAt: l.createdAt,
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
    },
    'Lives fetched'
  ).send(res);
});

/** POST /api/store/admin/lives/:id/end { reason } — stops a running live, or cancels a scheduled one (tickets refunded). */
const endLive = catchAsync(async (req, res) => {
  assertObjectId(req.params.id, 'Live');
  const live = await LiveStream.findById(req.params.id);
  if (!live) throw ApiError.notFound('Live not found');
  let result;
  if (live.status === LIVE_STATUS.LIVE) result = await liveService.end(live, { byAdmin: true });
  else if (live.status === LIVE_STATUS.SCHEDULED) result = (await liveService.cancel(live, { byUserId: req.user._id, reason: req.body.reason })).live;
  else throw ApiError.badRequest(`This live is already ${live.status}`);
  log.info('admin.live_stopped', { liveId: String(live._id), adminId: String(req.user._id) });
  await safeNotify({
    userId: live.host,
    fromUser: req.user._id,
    type: 'store_live',
    title: 'Your live was stopped by Fanitt',
    message: `"${live.title}": ${req.body.reason}`,
    relatedModel: 'LiveStream',
    relatedId: live._id,
  });
  return new ApiResponse(200, { _id: result._id, status: result.status }, 'Live stopped').send(res);
});

/** GET /api/store/admin/calls?status=&page= */
const listCalls = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = {};
  if (Object.values(CALL_STATUS).includes(req.query.status)) filter.status = req.query.status;
  const [calls, total] = await Promise.all([
    CallSession.find(filter)
      .populate('host', 'name email')
      .populate('caller', 'name email')
      .populate('store', 'name slug')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    CallSession.countDocuments(filter),
  ]);
  return new ApiResponse(200, { calls, total, page, pages: Math.ceil(total / limit) }, 'Calls fetched').send(res);
});

/** POST /api/store/admin/calls/:id/end — ends or cancels an open call and settles it. */
const endCall = catchAsync(async (req, res) => {
  assertObjectId(req.params.id, 'Call');
  const call = await callService.endByAdmin(req.params.id);
  log.info('admin.call_ended', { callId: String(req.params.id), adminId: String(req.user._id) });
  return new ApiResponse(200, call, 'Call ended and settled').send(res);
});

/** GET /api/store/admin/affiliate?status=&search=&page= */
const listAffiliateProducts = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = {};
  if (Object.values(AFFILIATE_STATUS).includes(req.query.status)) filter.status = req.query.status;
  const search = String(req.query.search || '').trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ title: pattern }, { merchant: pattern }, { url: pattern }, { owner: { $in: await userIdsMatching(search) } }];
  }
  const [products, total] = await Promise.all([
    AffiliateProduct.find(filter).populate('owner', 'name email').populate('store', 'name slug').sort({ createdAt: -1 }).skip(skip).limit(limit),
    AffiliateProduct.countDocuments(filter),
  ]);
  return new ApiResponse(200, { products, total, page, pages: Math.ceil(total / limit) }, 'Affiliate products').send(res);
});

/** PATCH /api/store/admin/affiliate/:id/remove { reason } */
const removeAffiliateProduct = catchAsync(async (req, res) => {
  assertObjectId(req.params.id, 'Product');
  const product = await AffiliateProduct.findById(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');
  product.status = AFFILIATE_STATUS.REMOVED;
  product.removedReason = req.body.reason;
  await product.save();
  await safeNotify({
    userId: product.owner,
    fromUser: req.user._id,
    type: 'store_update',
    title: 'An affiliate link was removed',
    message: `"${product.title}" was taken down: ${req.body.reason}`,
    relatedModel: 'Store',
    relatedId: product.store,
  });
  log.info('admin.affiliate_removed', { productId: String(product._id), adminId: String(req.user._id) });
  return new ApiResponse(200, product, 'Affiliate product removed').send(res);
});

/** PATCH /api/store/admin/affiliate/:id/restore */
const restoreAffiliateProduct = catchAsync(async (req, res) => {
  assertObjectId(req.params.id, 'Product');
  const product = await AffiliateProduct.findById(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');
  if (product.status !== AFFILIATE_STATUS.REMOVED) throw ApiError.badRequest('Product is not removed');
  product.status = AFFILIATE_STATUS.HIDDEN; // creator decides when to show it again
  product.removedReason = '';
  await product.save();
  return new ApiResponse(200, product, 'Affiliate product restored (hidden)').send(res);
});

/** GET /api/store/admin/fanbox?page= */
const listFanbox = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = { itemType: ORDER_ITEM.FANBOX, status: { $in: [ORDER_STATUS.PAID, ORDER_STATUS.REFUNDED] } };
  const [orders, total] = await Promise.all([
    StoreOrder.find(filter).populate('buyer', 'name email').populate('seller', 'name email').sort({ paidAt: -1 }).skip(skip).limit(limit),
    StoreOrder.countDocuments(filter),
  ]);
  return new ApiResponse(
    200,
    { fanbox: orders.map((o) => ({ ...serializeOrder(o), razorpayPaymentId: o.razorpayPaymentId })), total, page, pages: Math.ceil(total / limit) },
    'FanBox'
  ).send(res);
});

module.exports = {
  listAffiliateProducts,
  removeAffiliateProduct,
  restoreAffiliateProduct,
  listFanbox,
  listLives,
  endLive,
  listCalls,
  endCall,
  getOverview,
  listStores,
  getStore,
  reviewKyc,
  setStoreStatus,
  listProducts,
  removeProduct,
  restoreProduct,
  listOrders,
  refundOrder,
  getSettings,
  updateSettings,
  updateToolCard,
  uploadToolCardImage,
  updateBanner,
  uploadBannerImage,
};