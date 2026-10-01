const mongoose = require('mongoose');
const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const ApiError = require('../../utils/apiError');
const { Store, DigitalProduct, StoreOrder, LiveStream } = require('../models');
const { STORE_STATUS, PRODUCT_STATUS, ORDER_STATUS, ORDER_ITEM, LIVE_STATUS, LIVE_VISIBILITY } = require('../constants');
const settingsService = require('../services/settings.service');
const orderService = require('../services/order.service');
const invoiceService = require('../services/invoice.service');
const storage = require('../services/storage.service');
const callService = require('../services/call.service');
const { upcomingMeetsFor } = require('./meet.controller');
const { storefrontFor } = require('./affiliate.controller');
const analytics = require('../services/analytics.service');
const { visitorKey } = require('../utils/visitor');
const { FANBOX } = require('../constants');
const { publicStore, product: serializeProduct, order: serializeOrder } = require('../utils/serialize');
const { pageParams, escapeRegex } = require('../utils/text');
const { publicLive } = require('./live.controller');

// Everyone else: browse stores, buy, and use what they bought.

function assertObjectId(id, label) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound(`${label} not found`);
}

/** GET /api/store/config — tool cards, website banner, fees (public). */
const getConfig = catchAsync(async (req, res) => {
  const settings = await settingsService.getSettings();
  return new ApiResponse(200, settingsService.publicConfig(settings), 'Store config').send(res);
});

/** GET /api/store/stores?search=&page= — discover active stores. */
const listStores = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = { status: STORE_STATUS.ACTIVE, isOpen: true };
  const search = String(req.query.search || '').trim();
  if (search) filter.name = new RegExp(escapeRegex(search), 'i');
  const [stores, total] = await Promise.all([
    Store.find(filter).sort({ 'stats.orders': -1, createdAt: -1 }).skip(skip).limit(limit),
    Store.countDocuments(filter),
  ]);
  return new ApiResponse(200, { stores: stores.map(publicStore), total, page, pages: Math.ceil(total / limit) }, 'Stores fetched').send(res);
});

async function findVisibleStore(slugOrUserId) {
  const or = [{ slug: String(slugOrUserId).toLowerCase() }];
  if (mongoose.isValidObjectId(slugOrUserId)) or.push({ user: slugOrUserId }, { _id: slugOrUserId });
  const store = await Store.findOne({ $or: or, status: STORE_STATUS.ACTIVE });
  if (!store) throw ApiError.notFound('This store is not available');
  return store;
}

/** GET /api/store/stores/:slugOrUserId — a store page with its live products. */
const getStore = catchAsync(async (req, res) => {
  const store = await findVisibleStore(req.params.slugOrUserId);
  const isOwner = req.user && String(req.user._id) === String(store.user);
  const [products, lives, meets, calls, affiliate, settings] = await Promise.all([
    DigitalProduct.find({ store: store._id, status: PRODUCT_STATUS.PUBLISHED }).sort({ publishedAt: -1 }),
    LiveStream.find({
      store: store._id,
      visibility: LIVE_VISIBILITY.PUBLIC,
      $or: [{ status: LIVE_STATUS.LIVE }, { status: LIVE_STATUS.SCHEDULED, scheduledAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) } }],
    })
      .sort({ status: 1, scheduledAt: 1 })
      .limit(20),
    upcomingMeetsFor(store.creator),
    callService.publicCallInfo(store),
    storefrontFor(store._id),
    settingsService.getSettings(),
  ]);

  if (!isOwner) {
    Store.updateOne({ _id: store._id }, { $inc: { 'stats.views': 1 } }).catch(() => {});
    analytics.trackStoreView(store._id, visitorKey(req));
  }

  let ownedIds = [];
  if (req.user && products.length) {
    ownedIds = await StoreOrder.distinct('itemId', {
      buyer: req.user._id,
      status: ORDER_STATUS.PAID,
      itemId: { $in: products.map((p) => p._id) },
    });
  }
  const owned = new Set(ownedIds.map(String));

  return new ApiResponse(
    200,
    {
      store: publicStore(store),
      isOwner,
      products: products.map((p) => ({ ...serializeProduct(p), owned: owned.has(String(p._id)) })),
      lives: lives.map((l) => publicLive(l)),
      meets,
      calls,
      affiliate,
      fanbox: { presets: FANBOX.PRESETS, minAmount: FANBOX.MIN_AMOUNT, maxAmount: FANBOX.MAX_AMOUNT, feePercent: settings.fanboxFeePercent },
    },
    'Store fetched'
  ).send(res);
});

/** GET /api/store/products/:id — product page. */
const getProduct = catchAsync(async (req, res) => {
  assertObjectId(req.params.id, 'Product');
  const product = await DigitalProduct.findById(req.params.id);
  if (!product || product.status !== PRODUCT_STATUS.PUBLISHED) throw ApiError.notFound('This product is not available');
  const store = await Store.findOne({ _id: product.store, status: STORE_STATUS.ACTIVE });
  if (!store) throw ApiError.notFound('This product is not available');

  const isOwner = req.user && String(req.user._id) === String(store.user);
  const owned = req.user ? await orderService.hasPaidAccess(req.user._id, product._id) : false;
  if (!isOwner) {
    DigitalProduct.updateOne({ _id: product._id }, { $inc: { views: 1 } }).catch(() => {});
    analytics.trackProductView(store._id);
  }

  return new ApiResponse(200, { product: serializeProduct(product), store: publicStore(store), owned, isOwner }, 'Product fetched').send(res);
});

/** POST /api/store/products/:id/checkout */
const checkout = catchAsync(async (req, res) => {
  assertObjectId(req.params.id, 'Product');
  const result = await orderService.checkoutProduct(req.user, req.params.id, { payWith: req.body?.payWith });
  return new ApiResponse(
    result.paid ? 201 : 200,
    // `free` kept for older app builds: true when no payment step is needed.
    { order: serializeOrder(result.order), paid: result.paid, free: result.paid, razorpay: result.razorpay },
    result.paid ? 'Added to your library' : 'Complete the payment'
  ).send(res);
});

/** POST /api/store/orders/:id/verify */
const verifyPayment = catchAsync(async (req, res) => {
  assertObjectId(req.params.id, 'Order');
  const order = await orderService.verifyPayment(req.user._id, req.params.id, req.body);
  return new ApiResponse(200, serializeOrder(order), 'Payment confirmed — it’s in your library').send(res);
});

/** GET /api/store/orders/mine?page= — my purchases. */
const listMyOrders = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = { buyer: req.user._id, status: { $in: [ORDER_STATUS.PAID, ORDER_STATUS.REFUNDED] } };
  const [orders, total] = await Promise.all([
    StoreOrder.find(filter).populate('store', 'name slug logoUrl').sort({ paidAt: -1 }).skip(skip).limit(limit),
    StoreOrder.countDocuments(filter),
  ]);
  return new ApiResponse(200, { orders: orders.map(serializeOrder), total, page, pages: Math.ceil(total / limit) }, 'Orders fetched').send(
    res
  );
});

/** GET /api/store/library — every product I own, with its files. */
const getLibrary = catchAsync(async (req, res) => {
  const orders = await StoreOrder.find({ buyer: req.user._id, status: ORDER_STATUS.PAID, itemType: ORDER_ITEM.DIGITAL_PRODUCT })
    .populate('store', 'name slug logoUrl')
    .sort({ paidAt: -1 });
  const products = await DigitalProduct.find({ _id: { $in: orders.map((o) => o.itemId) } });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = orders.map((o) => {
    const p = byId.get(String(o.itemId));
    return {
      orderId: o._id,
      purchasedAt: o.paidAt,
      invoiceNumber: o.invoiceNumber,
      store: o.store,
      // Snapshot title/cover stay even if the creator later deleted the product.
      product: p ? serializeProduct(p) : { _id: o.itemId, title: o.itemTitle, coverUrl: o.itemCoverUrl, files: [], fileCount: 0 },
      available: Boolean(p) && p.status !== PRODUCT_STATUS.REMOVED,
    };
  });
  return new ApiResponse(200, items, 'Library fetched').send(res);
});

/** GET /api/store/library/:productId/files/:fileId/download — short-lived link. */
const downloadFile = catchAsync(async (req, res) => {
  assertObjectId(req.params.productId, 'Product');
  const product = await DigitalProduct.findById(req.params.productId);
  if (!product) throw ApiError.notFound('Product not found');
  if (product.status === PRODUCT_STATUS.REMOVED) throw ApiError.forbidden('This product was removed by Fanitt');

  const isOwner = String(product.owner) === String(req.user._id);
  if (!isOwner && !(await orderService.hasPaidAccess(req.user._id, product._id))) {
    throw ApiError.forbidden('Buy this product to download its files', [], 'NOT_PURCHASED');
  }
  const file = product.files.id(req.params.fileId);
  if (!file) throw ApiError.notFound('File not found');

  const link = await storage.presignDownload(file.key, file.name);
  return new ApiResponse(200, { ...link, fileName: file.name, size: file.size, mimeType: file.mimeType }, 'Download link').send(res);
});

async function loadInvoiceOrder(user, orderId) {
  assertObjectId(orderId, 'Invoice');
  const order = await StoreOrder.findById(orderId).populate('buyer', 'name email').populate('seller', 'name').populate('store', 'name slug');
  if (!order || !order.invoiceNumber) throw ApiError.notFound('Invoice not found');
  const allowed =
    user.role === 'admin' || String(order.buyer?._id) === String(user._id) || String(order.seller?._id) === String(user._id);
  if (!allowed) throw ApiError.notFound('Invoice not found');
  return order;
}

/** GET /api/store/orders/:id/invoice — JSON (apps). */
const getInvoice = catchAsync(async (req, res) => {
  const order = await loadInvoiceOrder(req.user, req.params.id);
  return new ApiResponse(200, invoiceService.buildInvoice(order), 'Invoice').send(res);
});

/** GET /api/store/orders/:id/invoice.html — printable page. */
const getInvoiceHtml = catchAsync(async (req, res) => {
  const order = await loadInvoiceOrder(req.user, req.params.id);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'private, no-store');
  return res.send(invoiceService.renderInvoiceHtml(invoiceService.buildInvoice(order)));
});

module.exports = {
  getConfig,
  listStores,
  getStore,
  getProduct,
  checkout,
  verifyPayment,
  listMyOrders,
  getLibrary,
  downloadFile,
  getInvoice,
  getInvoiceHtml,
};
