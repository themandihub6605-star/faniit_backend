const mongoose = require('mongoose');
const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const ApiError = require('../../utils/apiError');
const Store = require('../models/Store.model');
const ShopProduct = require('../models/ShopProduct.model');
const ShopOrder = require('../models/ShopOrder.model');
const { STORE_STATUS } = require('../constants');
const storeService = require('../services/store.service');
const shop = require('../services/commerce.service');
const { escapeRegex, pageParams } = require('../utils/text');
const log = require('../utils/logger');

// Physical products: public browsing, cart, addresses, checkout, orders
// (buyer side) and products + orders (seller side).
// Routes: routes/commerce.routes.js → /api/store/shop/...

const { SHOP_PRODUCT_STATUS: P, SHOP_CATEGORIES } = require('../shop.constants');
const { STATUS } = shop;
const MAX_IMAGES = 4;

const ok = (res, data, message, status = 200) => new ApiResponse(status, data, message).send(res);

function assertId(id, label) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound(`${label} not found`);
}

const SORTS = {
  new: { publishedAt: -1, _id: -1 },
  popular: { salesCount: -1, views: -1, _id: -1 },
  price_low: { price: 1, _id: 1 },
  price_high: { price: -1, _id: -1 },
};

async function sellingStores(filter = {}) {
  const stores = await Store.find({ ...filter, status: STORE_STATUS.ACTIVE, isOpen: true }).select('_id name slug logoUrl');
  return new Map(stores.map((s) => [String(s._id), s]));
}

// ======================= public =======================

/** GET /shop/config — categories and what payment options exist. */
const getConfig = catchAsync(async (req, res) => {
  const s = await shop.shopSettings();
  return ok(res, { enabled: s.enabled, categories: SHOP_CATEGORIES, codEnabled: s.codEnabled, onlineEnabled: s.onlineEnabled, codMaxAmount: s.codMaxAmount }, 'Shop config');
});

/** GET /shop/products?category=&search=&sort=&store=&exclude=&page=&limit= */
const listProducts = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, 20, 50);
  const storeFilter = {};
  if (req.query.store) {
    if (!mongoose.isValidObjectId(req.query.store)) return ok(res, { products: [], total: 0, page, pages: 0 }, 'Products fetched');
    storeFilter._id = req.query.store;
  }
  const storeMap = await sellingStores(storeFilter);
  const filter = { status: P.PUBLISHED, store: { $in: [...storeMap.keys()] } };
  if (SHOP_CATEGORIES.includes(req.query.category)) filter.category = req.query.category;
  const search = String(req.query.search || '').trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ title: pattern }, { description: pattern }];
  }
  if (req.query.exclude && mongoose.isValidObjectId(req.query.exclude)) filter._id = { $ne: req.query.exclude };
  if (req.query.inStock === 'true') filter.$and = [{ $or: [{ stock: { $gt: 0 } }, { 'variants.stock': { $gt: 0 } }] }];

  const [products, total] = await Promise.all([
    ShopProduct.find(filter).sort(SORTS[req.query.sort] || SORTS.new).skip(skip).limit(limit),
    ShopProduct.countDocuments(filter),
  ]);
  return ok(
    res,
    {
      products: products.map((p) => shop.productView(p, { store: storeMap.get(String(p.store)) })),
      total,
      page,
      pages: Math.ceil(total / limit),
    },
    'Products fetched'
  );
});

/** GET /shop/products/:id — full product + more from the same store. */
const getProduct = catchAsync(async (req, res) => {
  assertId(req.params.id, 'Product');
  const product = await ShopProduct.findById(req.params.id);
  const isOwner = product && req.user && String(product.seller) === String(req.user._id);
  if (!product || (product.status !== P.PUBLISHED && !isOwner)) throw ApiError.notFound('This product is not available');
  const store = await Store.findById(product.store).select('name slug logoUrl tagline status isOpen user creator');
  if (!isOwner && !shop.storeIsSelling(store)) throw ApiError.notFound('This product is not available');

  if (!isOwner) ShopProduct.updateOne({ _id: product._id }, { $inc: { views: 1 } }).catch(() => {});

  const moreFromStore = await ShopProduct.find({ store: product.store, status: P.PUBLISHED, _id: { $ne: product._id } })
    .sort(SORTS.popular)
    .limit(6);

  return ok(
    res,
    {
      ...shop.productView(product, { store }),
      isOwner: Boolean(isOwner),
      status: isOwner ? product.status : undefined,
      store: store ? { ...shop.storeCard(store), tagline: store.tagline || '', user: store.user } : null,
      moreFromStore: moreFromStore.map((p) => shop.productView(p, { store })),
    },
    'Product fetched'
  );
});

// ======================= buyer: cart =======================

const getCart = catchAsync(async (req, res) => ok(res, await shop.cartView(req.user._id), 'Cart fetched'));
const getCartCount = catchAsync(async (req, res) => ok(res, { count: await shop.cartCount(req.user._id) }, 'Cart count'));
const addToCart = catchAsync(async (req, res) => ok(res, await shop.addToCart(req.user._id, req.body), 'Added to cart'));
const updateCartItem = catchAsync(async (req, res) => {
  assertId(req.params.itemId, 'Cart item');
  return ok(res, await shop.updateCartItem(req.user._id, req.params.itemId, req.body.qty), 'Cart updated');
});
const removeCartItem = catchAsync(async (req, res) => {
  assertId(req.params.itemId, 'Cart item');
  return ok(res, await shop.removeCartItem(req.user._id, req.params.itemId), 'Removed from cart');
});
const clearCart = catchAsync(async (req, res) => ok(res, await shop.clearCart(req.user._id), 'Cart cleared'));

// ======================= buyer: addresses =======================

const listAddresses = catchAsync(async (req, res) => ok(res, await shop.listAddresses(req.user._id), 'Addresses fetched'));
const createAddress = catchAsync(async (req, res) => ok(res, await shop.saveAddress(req.user._id, req.body), 'Address saved', 201));
const updateAddress = catchAsync(async (req, res) => ok(res, await shop.saveAddress(req.user._id, req.body, req.params.id), 'Address updated'));
const setDefaultAddress = catchAsync(async (req, res) => ok(res, await shop.setDefaultAddress(req.user._id, req.params.id), 'Default address set'));
const deleteAddress = catchAsync(async (req, res) => {
  await shop.deleteAddress(req.user._id, req.params.id);
  return ok(res, null, 'Address deleted');
});

// ======================= buyer: checkout & orders =======================

/** POST /shop/checkout/preview — totals, COD availability, problems. */
const previewCheckout = catchAsync(async (req, res) => ok(res, await shop.previewCheckout(req.user._id, req.body), 'Checkout summary'));

/** POST /shop/checkout — places the order(s). */
const checkout = catchAsync(async (req, res) => {
  const result = await shop.checkout(req.user, req.body);
  await ShopOrder.populate(result.orders, { path: 'store', select: 'name slug logoUrl' });
  return ok(
    res,
    {
      checkoutId: result.checkoutId,
      placed: result.placed,
      orders: result.orders.map((o) => shop.orderView(o)),
      total: result.orders.reduce((s, o) => s + o.total, 0),
      razorpay: result.razorpay,
    },
    result.placed ? 'Order placed' : 'Complete the payment',
    201
  );
});

/** POST /shop/checkout/:checkoutId/verify — after the Razorpay sheet succeeds. */
const verifyCheckout = catchAsync(async (req, res) => {
  const orders = await shop.verifyCheckout(req.user._id, req.params.checkoutId, req.body);
  await ShopOrder.populate(orders, { path: 'store', select: 'name slug logoUrl' });
  return ok(res, { checkoutId: req.params.checkoutId, placed: true, orders: orders.map((o) => shop.orderView(o)) }, 'Payment confirmed — order placed');
});

/** GET /shop/orders?status=active|delivered|cancelled */
const listMyOrders = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, 20, 50);
  // Unpaid / failed online checkouts aren't real orders, so they're never listed.
  const filter = { buyer: req.user._id, status: { $nin: [STATUS.PAYMENT_FAILED, STATUS.AWAITING_PAYMENT] } };
  if (req.query.status === 'active') filter.status = { $in: [STATUS.PLACED, STATUS.CONFIRMED, STATUS.SHIPPED] };
  else if (req.query.status === 'delivered') filter.status = STATUS.DELIVERED;
  else if (req.query.status === 'cancelled') filter.status = STATUS.CANCELLED;

  const [orders, total] = await Promise.all([
    ShopOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('store', 'name slug logoUrl'),
    ShopOrder.countDocuments(filter),
  ]);
  return ok(res, { orders: orders.map((o) => shop.orderView(o)), total, page, pages: Math.ceil(total / limit) }, 'Orders fetched');
});

const getMyOrder = catchAsync(async (req, res) => {
  assertId(req.params.id, 'Order');
  const order = await ShopOrder.findOne({ _id: req.params.id, buyer: req.user._id }).populate('store', 'name slug logoUrl');
  if (!order) throw ApiError.notFound('Order not found');
  return ok(res, shop.orderView(order), 'Order fetched');
});

const cancelMyOrder = catchAsync(async (req, res) => {
  assertId(req.params.id, 'Order');
  const order = await ShopOrder.findOne({ _id: req.params.id, buyer: req.user._id });
  if (!order) throw ApiError.notFound('Order not found');
  const updated = await shop.cancelOrder(order, { by: 'buyer', reason: req.body.reason });
  await updated.populate('store', 'name slug logoUrl');
  return ok(res, shop.orderView(updated), 'Order cancelled');
});

const markReceived = catchAsync(async (req, res) => {
  const order = await shop.buyerReceived(req.user._id, req.params.id);
  await order.populate('store', 'name slug logoUrl');
  return ok(res, shop.orderView(order), 'Thanks for confirming!');
});

// ======================= seller: products =======================

async function loadOwn(userId, id) {
  assertId(id, 'Product');
  const product = await ShopProduct.findOne({ _id: id, seller: userId });
  if (!product) throw ApiError.notFound('Product not found');
  if (product.status === P.REMOVED) {
    throw ApiError.forbidden(`This product was removed by Fanitt: ${product.removedReason || 'policy violation'}`, 'PRODUCT_REMOVED');
  }
  return product;
}

const sendOwn = (res, product, message, status = 200) => ok(res, shop.productView(product, { owner: true }), message, status);

/** Applies editable fields; variants keep their ids so carts stay valid. */
function applyFields(product, body) {
  const fields = ['title', 'description', 'highlights', 'category', 'mrp', 'price', 'stock', 'variantName', 'deliveryCharge', 'deliveryDays', 'codAvailable', 'returnPolicy'];
  fields.forEach((f) => {
    if (body[f] !== undefined) product[f] = body[f];
  });
  if (body.variants !== undefined) {
    product.variants = body.variants.map((v) => {
      const existing = v._id ? product.variants.id(v._id) : null;
      return existing ? { _id: existing._id, label: v.label, stock: v.stock } : { label: v.label, stock: v.stock };
    });
    if (!product.variants.length) product.variantName = '';
  }
  if (product.mrp && product.mrp < product.price) throw ApiError.badRequest('MRP must be more than the selling price (or 0 for no MRP)');
}

const listMyProducts = catchAsync(async (req, res) => {
  const filter = { seller: req.user._id };
  if (Object.values(P).includes(req.query.status)) filter.status = req.query.status;
  const products = await ShopProduct.find(filter).sort({ createdAt: -1 });
  return ok(res, products.map((p) => shop.productView(p, { owner: true })), 'Products fetched');
});

const getMyProduct = catchAsync(async (req, res) => {
  assertId(req.params.id, 'Product');
  const product = await ShopProduct.findOne({ _id: req.params.id, seller: req.user._id });
  if (!product) throw ApiError.notFound('Product not found');
  return sendOwn(res, product, 'Product fetched');
});

/** POST /shop/me/products — creates a draft (store must be active). */
const createProduct = catchAsync(async (req, res) => {
  const store = await storeService.requireActiveStore(req.user._id);
  const count = await ShopProduct.countDocuments({ seller: req.user._id, status: { $ne: P.REMOVED } });
  if (count >= 500) throw ApiError.badRequest('You can have up to 500 products');
  const product = new ShopProduct({ store: store._id, seller: req.user._id });
  applyFields(product, req.body);
  await product.save();
  log.info('shop.product_created', { productId: String(product._id), storeId: String(store._id) });
  return sendOwn(res, product, 'Product saved as draft', 201);
});

const updateProduct = catchAsync(async (req, res) => {
  const product = await loadOwn(req.user._id, req.params.id);
  applyFields(product, req.body);
  if (product.status === P.PUBLISHED && !product.images.length) throw ApiError.badRequest('Add at least one photo');
  await product.save();
  return sendOwn(res, product, 'Product updated');
});

const deleteProduct = catchAsync(async (req, res) => {
  const product = await loadOwn(req.user._id, req.params.id);
  const open = await ShopOrder.exists({ 'items.product': product._id, status: { $in: [STATUS.AWAITING_PAYMENT, STATUS.PLACED, STATUS.CONFIRMED, STATUS.SHIPPED] } });
  if (open) throw ApiError.badRequest('This product has orders in progress. Unpublish it instead, and delete it after they are delivered.');
  const sold = await ShopOrder.exists({ 'items.product': product._id });
  if (sold) {
    // Past orders keep their own copy, but keep the product hidden rather than gone.
    product.status = P.UNPUBLISHED;
    await product.save();
    return ok(res, shop.productView(product, { owner: true }), 'Product hidden (it has past orders)');
  }
  await product.deleteOne();
  return ok(res, null, 'Product deleted');
});

/** POST /shop/me/products/:id/images — multipart `images` (adds up to 4 total). */
const uploadImages = catchAsync(async (req, res) => {
  const files = (req.files || []).filter((f) => f.path);
  if (!files.length) throw ApiError.badRequest('Choose at least one photo');
  const product = await loadOwn(req.user._id, req.params.id);
  const room = MAX_IMAGES - product.images.length;
  if (room <= 0) throw ApiError.badRequest(`You can add up to ${MAX_IMAGES} photos — remove one first`);
  product.images.push(...files.slice(0, room).map((f) => f.path));
  await product.save();
  const skipped = files.length - Math.min(files.length, room);
  return sendOwn(res, product, skipped ? `Added ${room} photo(s) — only ${MAX_IMAGES} are allowed` : 'Photos added');
});

/** PUT /shop/me/products/:id/images — reorder (first = cover). */
const reorderImages = catchAsync(async (req, res) => {
  const product = await loadOwn(req.user._id, req.params.id);
  const current = new Set(product.images);
  const next = req.body.images.filter((u) => current.has(u));
  if (next.length !== product.images.length) throw ApiError.badRequest('Send every photo of the product, in the new order');
  product.images = next;
  await product.save();
  return sendOwn(res, product, 'Photos reordered');
});

/** DELETE /shop/me/products/:id/images  body: { url } */
const removeImage = catchAsync(async (req, res) => {
  const product = await loadOwn(req.user._id, req.params.id);
  if (!product.images.includes(req.body.url)) throw ApiError.notFound('Photo not found');
  if (product.status === P.PUBLISHED && product.images.length === 1) throw ApiError.badRequest('A live product needs at least one photo');
  product.images = product.images.filter((u) => u !== req.body.url);
  await product.save();
  return sendOwn(res, product, 'Photo removed');
});

const publishProduct = catchAsync(async (req, res) => {
  await storeService.requireActiveStore(req.user._id);
  const product = await loadOwn(req.user._id, req.params.id);
  if (!product.images.length) throw ApiError.badRequest('Add at least one photo before publishing');
  if (product.variants.length && !product.variantName) throw ApiError.badRequest('Name your options (e.g. Size) before publishing');
  product.status = P.PUBLISHED;
  if (!product.publishedAt) product.publishedAt = new Date();
  await product.save();
  return sendOwn(res, product, 'Product is live');
});

const unpublishProduct = catchAsync(async (req, res) => {
  const product = await loadOwn(req.user._id, req.params.id);
  product.status = P.UNPUBLISHED;
  await product.save();
  return sendOwn(res, product, 'Product hidden');
});

// ======================= seller: orders =======================

const SELLER_TABS = {
  new: [STATUS.PLACED],
  to_ship: [STATUS.CONFIRMED],
  shipped: [STATUS.SHIPPED],
  delivered: [STATUS.DELIVERED],
  cancelled: [STATUS.CANCELLED],
};

/** GET /shop/me/orders?tab=new|to_ship|shipped|delivered|cancelled */
const listSellerOrders = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, 20, 50);
  const statuses = SELLER_TABS[req.query.tab] || [STATUS.PLACED, STATUS.CONFIRMED, STATUS.SHIPPED, STATUS.DELIVERED, STATUS.CANCELLED];
  const filter = { seller: req.user._id, status: { $in: statuses } };
  const [orders, total, counts] = await Promise.all([
    ShopOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('buyer', 'name avatar'),
    ShopOrder.countDocuments(filter),
    ShopOrder.aggregate([{ $match: { seller: req.user._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  const tabCounts = Object.fromEntries(Object.entries(SELLER_TABS).map(([tab, sts]) => [tab, sts.reduce((s, st) => s + (byStatus[st] || 0), 0)]));
  return ok(res, { orders: orders.map((o) => shop.orderView(o, { as: 'seller' })), total, page, pages: Math.ceil(total / limit), tabCounts }, 'Orders fetched');
});

async function sellerOrderResponse(res, order, message) {
  await order.populate('buyer', 'name avatar');
  return ok(res, shop.orderView(order, { as: 'seller' }), message);
}

const getSellerOrder = catchAsync(async (req, res) => {
  assertId(req.params.id, 'Order');
  const order = await ShopOrder.findOne({ _id: req.params.id, seller: req.user._id, status: { $ne: STATUS.AWAITING_PAYMENT } });
  if (!order) throw ApiError.notFound('Order not found');
  return sellerOrderResponse(res, order, 'Order fetched');
});

const confirmOrder = catchAsync(async (req, res) => sellerOrderResponse(res, await shop.sellerConfirm(req.user._id, req.params.id), 'Order confirmed'));
const shipOrder = catchAsync(async (req, res) => sellerOrderResponse(res, await shop.sellerShip(req.user._id, req.params.id, req.body), 'Marked as shipped'));
const deliverOrder = catchAsync(async (req, res) => sellerOrderResponse(res, await shop.sellerDeliver(req.user._id, req.params.id), 'Marked as delivered'));
const sellerCancelOrder = catchAsync(async (req, res) => {
  assertId(req.params.id, 'Order');
  const order = await ShopOrder.findOne({ _id: req.params.id, seller: req.user._id });
  if (!order) throw ApiError.notFound('Order not found');
  return sellerOrderResponse(res, await shop.cancelOrder(order, { by: 'seller', reason: req.body.reason }), 'Order cancelled');
});

/** GET /shop/me/summary — numbers for the seller dashboard. */
const getSellerSummary = catchAsync(async (req, res) => {
  const sellerId = req.user._id;
  const [products, statusCounts, money] = await Promise.all([
    ShopProduct.aggregate([{ $match: { seller: sellerId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ShopOrder.aggregate([{ $match: { seller: sellerId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ShopOrder.aggregate([
      { $match: { seller: sellerId, status: STATUS.DELIVERED } },
      { $group: { _id: null, sales: { $sum: '$total' }, fees: { $sum: '$feeAmount' }, earnings: { $sum: '$creatorEarning' } } },
    ]),
  ]);
  const p = Object.fromEntries(products.map((x) => [x._id, x.n]));
  const o = Object.fromEntries(statusCounts.map((x) => [x._id, x.n]));
  return ok(
    res,
    {
      products: { total: Object.values(p).reduce((a, b) => a + b, 0), published: p[P.PUBLISHED] || 0, draft: p[P.DRAFT] || 0 },
      orders: {
        new: o[STATUS.PLACED] || 0,
        toShip: o[STATUS.CONFIRMED] || 0,
        shipped: o[STATUS.SHIPPED] || 0,
        delivered: o[STATUS.DELIVERED] || 0,
        cancelled: o[STATUS.CANCELLED] || 0,
      },
      sales: money[0]?.sales || 0,
      fees: money[0]?.fees || 0,
      earnings: money[0]?.earnings || 0,
    },
    'Summary fetched'
  );
});

module.exports = {
  getConfig,
  listProducts,
  getProduct,
  getCart,
  getCartCount,
  addToCart,
  updateCartItem,
  removeCartItem,
  clearCart,
  listAddresses,
  createAddress,
  updateAddress,
  setDefaultAddress,
  deleteAddress,
  previewCheckout,
  checkout,
  verifyCheckout,
  listMyOrders,
  getMyOrder,
  cancelMyOrder,
  markReceived,
  listMyProducts,
  getMyProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  uploadImages,
  reorderImages,
  removeImage,
  publishProduct,
  unpublishProduct,
  listSellerOrders,
  getSellerOrder,
  confirmOrder,
  shipOrder,
  deliverOrder,
  sellerCancelOrder,
  getSellerSummary,
};