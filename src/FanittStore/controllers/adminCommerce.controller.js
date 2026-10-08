const mongoose = require('mongoose');
const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const ApiError = require('../../utils/apiError');
const Store = require('../models/Store.model');
const ShopProduct = require('../models/ShopProduct.model');
const ShopOrder = require('../models/ShopOrder.model');
const shop = require('../services/commerce.service');
const settingsService = require('../services/settings.service');
const { safeNotify } = require('../services/notify.service');
const { escapeRegex, pageParams } = require('../utils/text');
const log = require('../utils/logger');

// Admin: physical products and orders. Routes → /api/store/admin/shop/...

const { SHOP_PRODUCT_STATUS: P, SHOP_CATEGORIES } = require('../shop.constants');
const { STATUS } = shop;
const ok = (res, data, message) => new ApiResponse(200, data, message).send(res);

function assertId(id, label) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound(`${label} not found`);
}

async function storeIdsMatching(search) {
  const stores = await Store.find({ name: new RegExp(escapeRegex(search), 'i') }).select('_id').limit(200);
  return stores.map((s) => s._id);
}

/** GET /admin/shop/overview */
const getOverview = catchAsync(async (req, res) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [products, orders, money, last30] = await Promise.all([
    ShopProduct.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ShopOrder.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ShopOrder.aggregate([
      { $match: { status: STATUS.DELIVERED } },
      { $group: { _id: '$paymentMethod', sales: { $sum: '$total' }, fees: { $sum: '$feeAmount' }, n: { $sum: 1 } } },
    ]),
    ShopOrder.aggregate([
      { $match: { placedAt: { $gte: since }, status: { $nin: [STATUS.AWAITING_PAYMENT, STATUS.PAYMENT_FAILED] } } },
      { $group: { _id: null, orders: { $sum: 1 }, value: { $sum: '$total' } } },
    ]),
  ]);
  const p = Object.fromEntries(products.map((x) => [x._id, x.n]));
  const o = Object.fromEntries(orders.map((x) => [x._id, x.n]));
  const m = Object.fromEntries(money.map((x) => [x._id, x]));
  const refundPending = await ShopOrder.countDocuments({ status: STATUS.CANCELLED, paymentMethod: 'online', paymentStatus: 'paid' });
  return ok(
    res,
    {
      products: { total: Object.values(p).reduce((a, b) => a + b, 0), published: p[P.PUBLISHED] || 0, removed: p[P.REMOVED] || 0 },
      orders: {
        placed: o[STATUS.PLACED] || 0,
        confirmed: o[STATUS.CONFIRMED] || 0,
        shipped: o[STATUS.SHIPPED] || 0,
        delivered: o[STATUS.DELIVERED] || 0,
        cancelled: o[STATUS.CANCELLED] || 0,
        awaitingPayment: o[STATUS.AWAITING_PAYMENT] || 0,
      },
      delivered: {
        sales: (m.cod?.sales || 0) + (m.online?.sales || 0),
        fees: (m.cod?.fees || 0) + (m.online?.fees || 0),
        codOrders: m.cod?.n || 0,
        onlineOrders: m.online?.n || 0,
      },
      last30Days: { orders: last30[0]?.orders || 0, value: last30[0]?.value || 0 },
      refundPending,
    },
    'Shop overview'
  );
});

/** GET /admin/shop/products?status=&search=&page= */
const listProducts = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, 20, 100);
  const filter = {};
  if (Object.values(P).includes(req.query.status)) filter.status = req.query.status;
  const search = String(req.query.search || '').trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ title: pattern }, { store: { $in: await storeIdsMatching(search) } }];
  }
  const [items, total] = await Promise.all([
    ShopProduct.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('store', 'name slug logoUrl'),
    ShopProduct.countDocuments(filter),
  ]);
  return ok(
    res,
    {
      items: items.map((p) => ({ ...shop.productView(p, { owner: true, store: p.store }) })),
      total,
      page,
      pages: Math.ceil(total / limit),
    },
    'Products fetched'
  );
});

const removeProduct = catchAsync(async (req, res) => {
  assertId(req.params.id, 'Product');
  const product = await ShopProduct.findById(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');
  product.status = P.REMOVED;
  product.removedReason = req.body.reason;
  await product.save();
  await safeNotify({
    userId: product.seller,
    type: 'store_sale',
    title: 'A product was removed',
    message: `"${product.title}" was removed from your store: ${req.body.reason}`,
    relatedModel: 'ShopProduct',
    relatedId: product._id,
  });
  log.info('admin.shop_product_removed', { productId: String(product._id), adminId: String(req.user._id) });
  return ok(res, shop.productView(product, { owner: true }), 'Product removed');
});

const restoreProduct = catchAsync(async (req, res) => {
  assertId(req.params.id, 'Product');
  const product = await ShopProduct.findById(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');
  if (product.status !== P.REMOVED) throw ApiError.badRequest('This product is not removed');
  product.status = P.UNPUBLISHED; // the creator publishes it again
  product.removedReason = '';
  await product.save();
  return ok(res, shop.productView(product, { owner: true }), 'Product restored as hidden — the creator can publish it again');
});

/** GET /admin/shop/orders?status=&method=&search=&refundPending=true&page= */
const listOrders = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, 20, 100);
  const filter = {};
  if (Object.values(STATUS).includes(req.query.status)) filter.status = req.query.status;
  if (['cod', 'online'].includes(req.query.method)) filter.paymentMethod = req.query.method;
  if (req.query.refundPending === 'true') Object.assign(filter, { status: STATUS.CANCELLED, paymentMethod: 'online', paymentStatus: 'paid' });
  const search = String(req.query.search || '').trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ orderNumber: pattern }, { checkoutId: pattern }, { 'address.name': pattern }, { 'address.phone': pattern }, { store: { $in: await storeIdsMatching(search) } }];
  }
  const [orders, total] = await Promise.all([
    ShopOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('store', 'name slug logoUrl').populate('buyer', 'name avatar email'),
    ShopOrder.countDocuments(filter),
  ]);
  return ok(
    res,
    {
      items: orders.map((o) => ({ ...shop.orderView(o, { as: 'admin' }), buyerEmail: o.buyer?.email || '' })),
      total,
      page,
      pages: Math.ceil(total / limit),
    },
    'Orders fetched'
  );
});

const getOrder = catchAsync(async (req, res) => {
  assertId(req.params.id, 'Order');
  const order = await ShopOrder.findById(req.params.id).populate('store', 'name slug logoUrl').populate('buyer', 'name avatar email phone');
  if (!order) throw ApiError.notFound('Order not found');
  return ok(res, { ...shop.orderView(order, { as: 'admin' }), buyerEmail: order.buyer?.email || '', buyerPhone: order.buyer?.phone || '' }, 'Order fetched');
});

const cancelOrder = catchAsync(async (req, res) => {
  assertId(req.params.id, 'Order');
  const order = await ShopOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  const updated = await shop.cancelOrder(order, { by: 'admin', reason: req.body.reason });
  log.info('admin.shop_order_cancelled', { orderId: String(updated._id), adminId: String(req.user._id) });
  return ok(res, shop.orderView(updated, { as: 'admin' }), 'Order cancelled');
});

const retryRefund = catchAsync(async (req, res) => {
  const order = await shop.retryRefund(req.params.id);
  return ok(res, shop.orderView(order, { as: 'admin' }), 'Refund issued');
});

function settingsView(s) {
  return {
    shopEnabled: s.shopEnabled !== false,
    shopFeePercent: s.shopFeePercent,
    shopCodEnabled: s.shopCodEnabled !== false,
    shopOnlineEnabled: s.shopOnlineEnabled !== false,
    shopCodMaxAmount: s.shopCodMaxAmount || 0,
  };
}

/** GET /admin/shop/settings */
const getSettings = catchAsync(async (req, res) => ok(res, settingsView(await settingsService.getSettings({ fresh: true })), 'Shop settings'));

/** PATCH /admin/shop/settings */
const updateSettings = catchAsync(async (req, res) => {
  const settings = await settingsService.getSettings({ fresh: true });
  ['shopEnabled', 'shopFeePercent', 'shopCodEnabled', 'shopOnlineEnabled', 'shopCodMaxAmount'].forEach((f) => {
    if (req.body[f] !== undefined) settings[f] = req.body[f];
  });
  if (settings.shopCodEnabled === false && settings.shopOnlineEnabled === false) {
    throw ApiError.badRequest('Keep at least one payment option on');
  }
  settings.updatedBy = req.user._id;
  await settings.save();
  settingsService.invalidate();
  log.info('admin.shop_settings_updated', { adminId: String(req.user._id), fields: Object.keys(req.body) });
  return ok(res, settingsView(settings), 'Shop settings saved');
});

module.exports = {
  getOverview,
  listProducts,
  removeProduct,
  restoreProduct,
  listOrders,
  getOrder,
  cancelOrder,
  retryRefund,
  getSettings,
  updateSettings,
};