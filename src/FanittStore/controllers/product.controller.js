const mongoose = require('mongoose');
const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const ApiError = require('../../utils/apiError');
const { DigitalProduct, StoreOrder } = require('../models');
const { PRODUCT_STATUS, LIMITS, PRODUCT_FILE_TYPES, ORDER_STATUS } = require('../constants');
const storeService = require('../services/store.service');
const storage = require('../services/storage.service');
const { product: serializeProduct, order: serializeOrder } = require('../utils/serialize');
const { pageParams } = require('../utils/text');
const log = require('../utils/logger');

// Creator side: build, publish and track digital products.

function assertObjectId(id, label = 'Product') {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound(`${label} not found`);
}

async function loadOwnProduct(userId, productId) {
  assertObjectId(productId);
  const product = await DigitalProduct.findOne({ _id: productId, owner: userId });
  if (!product) throw ApiError.notFound('Product not found');
  if (product.status === PRODUCT_STATUS.REMOVED) {
    throw ApiError.forbidden(`This product was removed by Fanitt: ${product.removedReason || 'policy violation'}`, [], 'PRODUCT_REMOVED');
  }
  return product;
}

const send = (res, product, message, status = 200) => new ApiResponse(status, serializeProduct(product, { owner: true }), message).send(res);

/** GET /api/store/me/products?status= */
const listMyProducts = catchAsync(async (req, res) => {
  const filter = { owner: req.user._id };
  if (Object.values(PRODUCT_STATUS).includes(req.query.status)) filter.status = req.query.status;
  const products = await DigitalProduct.find(filter).sort({ createdAt: -1 });
  return new ApiResponse(200, products.map((p) => serializeProduct(p, { owner: true })), 'Products fetched').send(res);
});

/** GET /api/store/me/products/:id */
const getMyProduct = catchAsync(async (req, res) => {
  assertObjectId(req.params.id);
  const product = await DigitalProduct.findOne({ _id: req.params.id, owner: req.user._id });
  if (!product) throw ApiError.notFound('Product not found');
  return send(res, product, 'Product fetched');
});

/** POST /api/store/me/products — creates a draft. Store must be active. */
const createProduct = catchAsync(async (req, res) => {
  const store = await storeService.requireActiveStore(req.user._id);
  const product = await DigitalProduct.create({
    store: store._id,
    owner: req.user._id,
    title: req.body.title,
    description: req.body.description || '',
    category: req.body.category || 'other',
    price: req.body.price,
  });
  log.info('product.created', { productId: String(product._id), storeId: String(store._id) });
  return send(res, product, 'Draft created', 201);
});

/** PATCH /api/store/me/products/:id */
const updateProduct = catchAsync(async (req, res) => {
  const product = await loadOwnProduct(req.user._id, req.params.id);
  ['title', 'description', 'category', 'price'].forEach((field) => {
    if (req.body[field] !== undefined) product[field] = req.body[field];
  });
  await product.save();
  return send(res, product, 'Product updated');
});

/** POST /api/store/me/products/:id/cover (multipart "image") */
const uploadCover = catchAsync(async (req, res) => {
  if (!req.file?.path) throw ApiError.badRequest('Choose a cover image');
  const product = await loadOwnProduct(req.user._id, req.params.id);
  product.coverUrl = req.file.path;
  await product.save();
  return send(res, product, 'Cover updated');
});

/**
 * POST /api/store/me/products/:id/files/upload-url
 * Step 1 of a file upload: returns a signed link the app PUTs the file to.
 */
const requestFileUpload = catchAsync(async (req, res) => {
  const product = await loadOwnProduct(req.user._id, req.params.id);
  if (product.files.length >= LIMITS.FILES_PER_PRODUCT) {
    throw ApiError.badRequest(`A product can have up to ${LIMITS.FILES_PER_PRODUCT} files`);
  }
  const key = storage.buildKey('products', String(product._id), req.body.fileName);
  const { url, expiresIn } = await storage.presignUpload({ key, mimeType: req.body.mimeType, size: req.body.size });
  return new ApiResponse(
    200,
    { uploadUrl: url, method: 'PUT', headers: { 'Content-Type': req.body.mimeType }, key, expiresIn },
    'Upload the file to uploadUrl, then confirm it'
  ).send(res);
});

/**
 * POST /api/store/me/products/:id/files
 * Step 2: confirms the upload. The server checks the file really exists
 * in storage and uses the stored size/type (not what the app claims).
 */
const confirmFile = catchAsync(async (req, res) => {
  const product = await loadOwnProduct(req.user._id, req.params.id);
  const { key, fileName } = req.body;
  if (!key.startsWith(`store/products/${product._id}/`)) throw ApiError.badRequest('This upload does not belong to this product');
  if (product.files.some((f) => f.key === key)) return send(res, product, 'File already added');
  if (product.files.length >= LIMITS.FILES_PER_PRODUCT) {
    throw ApiError.badRequest(`A product can have up to ${LIMITS.FILES_PER_PRODUCT} files`);
  }

  const info = await storage.head(key);
  if (!info) throw ApiError.badRequest('We could not find the uploaded file — upload it again');
  if (info.size > LIMITS.MAX_FILE_BYTES) {
    storage.remove(key);
    throw ApiError.badRequest('This file is larger than 500 MB');
  }
  const mimeType = info.mimeType.split(';')[0].trim();
  if (!PRODUCT_FILE_TYPES.includes(mimeType)) {
    storage.remove(key);
    throw ApiError.badRequest('This file type is not supported');
  }

  product.files.push({ key, name: fileName, size: info.size, mimeType });
  await product.save();
  log.info('product.file_added', { productId: String(product._id), size: info.size, mimeType });
  return send(res, product, 'File added', 201);
});

/** DELETE /api/store/me/products/:id/files/:fileId */
const removeFile = catchAsync(async (req, res) => {
  const product = await loadOwnProduct(req.user._id, req.params.id);
  const file = product.files.id(req.params.fileId);
  if (!file) throw ApiError.notFound('File not found');
  if (product.status === PRODUCT_STATUS.PUBLISHED && product.files.length === 1) {
    throw ApiError.badRequest('A published product needs at least one file — add another first, or unpublish it');
  }
  const { key } = file;
  file.deleteOne();
  await product.save();
  // Buyers keep access while it's published, so only delete from storage
  // if nobody has bought it yet.
  if (product.salesCount === 0) storage.remove(key);
  return send(res, product, 'File removed');
});

/** GET /api/store/me/products/:id/files/:fileId/preview — owner downloads their own file. */
const previewFile = catchAsync(async (req, res) => {
  const product = await loadOwnProduct(req.user._id, req.params.id);
  const file = product.files.id(req.params.fileId);
  if (!file) throw ApiError.notFound('File not found');
  const link = await storage.presignDownload(file.key, file.name);
  return new ApiResponse(200, link, 'Download link').send(res);
});

/** POST /api/store/me/products/:id/publish */
const publishProduct = catchAsync(async (req, res) => {
  await storeService.requireActiveStore(req.user._id);
  const product = await loadOwnProduct(req.user._id, req.params.id);
  const missing = [];
  if (!product.coverUrl) missing.push('a cover image');
  if (!product.description || product.description.trim().length < 20) missing.push('a description (20+ characters)');
  if (product.files.length === 0) missing.push('at least one file');
  if (missing.length) throw ApiError.badRequest(`Add ${missing.join(', ')} before publishing`, [], 'PRODUCT_INCOMPLETE');

  product.status = PRODUCT_STATUS.PUBLISHED;
  product.publishedAt = product.publishedAt || new Date();
  await product.save();
  log.info('product.published', { productId: String(product._id) });
  return send(res, product, 'Product is live');
});

/** POST /api/store/me/products/:id/unpublish — hides it; buyers keep access. */
const unpublishProduct = catchAsync(async (req, res) => {
  const product = await loadOwnProduct(req.user._id, req.params.id);
  if (product.status !== PRODUCT_STATUS.PUBLISHED) throw ApiError.badRequest('Only live products can be unpublished');
  product.status = PRODUCT_STATUS.UNPUBLISHED;
  await product.save();
  return send(res, product, 'Product hidden from your store');
});

/** DELETE /api/store/me/products/:id — only if nobody bought it. */
const deleteProduct = catchAsync(async (req, res) => {
  const product = await loadOwnProduct(req.user._id, req.params.id);
  const sold = await StoreOrder.exists({ itemId: product._id, status: { $in: [ORDER_STATUS.PAID, ORDER_STATUS.REFUNDED] } });
  if (sold) throw ApiError.conflict('People have bought this product — unpublish it instead so they keep access', [], 'PRODUCT_HAS_SALES');
  const keys = product.files.map((f) => f.key);
  await product.deleteOne();
  keys.forEach((k) => storage.remove(k));
  log.info('product.deleted', { productId: String(product._id) });
  return new ApiResponse(200, null, 'Product deleted').send(res);
});

/** GET /api/store/me/sales?page= — orders on my products. */
const listMySales = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = { seller: req.user._id, status: { $in: [ORDER_STATUS.PAID, ORDER_STATUS.REFUNDED] } };
  const [orders, total] = await Promise.all([
    StoreOrder.find(filter).populate('buyer', 'name avatarUrl').sort({ paidAt: -1, createdAt: -1 }).skip(skip).limit(limit),
    StoreOrder.countDocuments(filter),
  ]);
  return new ApiResponse(200, { orders: orders.map(serializeOrder), total, page, pages: Math.ceil(total / limit) }, 'Sales fetched').send(
    res
  );
});

/** GET /api/store/me/summary — earnings overview for the store dashboard. */
const getMySummary = catchAsync(async (req, res) => {
  const store = await storeService.requireMyStore(req.user._id);
  const since = new Date();
  since.setDate(since.getDate() - 29);
  since.setHours(0, 0, 0, 0);

  const [recentOrders, topProducts, productCounts] = await Promise.all([
    StoreOrder.find({ seller: req.user._id, status: ORDER_STATUS.PAID, paidAt: { $gte: since } }).select('paidAt amount creatorEarning'),
    DigitalProduct.find({ owner: req.user._id, salesCount: { $gt: 0 } })
      .sort({ revenue: -1 })
      .limit(5)
      .select('title coverUrl salesCount revenue price'),
    DigitalProduct.aggregate([{ $match: { owner: req.user._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);

  // Daily totals for the last 30 days, by India date.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const days = new Map();
  for (let i = 0; i < 30; i += 1) {
    const d = new Date(since.getTime() + i * 24 * 60 * 60 * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10);
    days.set(d, { date: d, orders: 0, gross: 0, net: 0 });
  }
  recentOrders.forEach((o) => {
    const d = new Date(o.paidAt.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
    const day = days.get(d) || { date: d, orders: 0, gross: 0, net: 0 };
    day.orders += 1;
    day.gross += o.amount;
    day.net += o.creatorEarning;
    days.set(d, day);
  });
  const byDay = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));

  return new ApiResponse(
    200,
    {
      stats: store.stats,
      last30Days: byDay,
      topProducts,
      products: Object.fromEntries(productCounts.map((p) => [p._id, p.count])),
    },
    'Summary fetched'
  ).send(res);
});

module.exports = {
  listMyProducts,
  getMyProduct,
  createProduct,
  updateProduct,
  uploadCover,
  requestFileUpload,
  confirmFile,
  removeFile,
  previewFile,
  publishProduct,
  unpublishProduct,
  deleteProduct,
  listMySales,
  getMySummary,
};
