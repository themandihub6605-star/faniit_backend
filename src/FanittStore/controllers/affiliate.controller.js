const mongoose = require('mongoose');
const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const ApiError = require('../../utils/apiError');
const { AffiliateProduct, AffiliateCollection, AffiliateEarning, Store } = require('../models');
const { AFFILIATE_STATUS, AFFILIATE_EARNING_STATUS, LIMITS, STORE_STATUS } = require('../constants');
const storeService = require('../services/store.service');
const linkPreview = require('../services/linkPreview.service');
const analytics = require('../services/analytics.service');
const { visitorKey } = require('../utils/visitor');
const { pageParams } = require('../utils/text');
const log = require('../utils/logger');

// Affiliate Store: products from other shops the creator recommends,
// collections of them, click tracking and the creator's own earnings log.

function assertId(id, label) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound(`${label} not found`);
}

/** Public shape: the real affiliate URL is hidden behind the /go/:id link. */
function publicProduct(p) {
  return {
    _id: p._id,
    title: p.title,
    description: p.description,
    imageUrl: p.imageUrl,
    price: p.price,
    merchant: p.merchant,
    category: p.category,
    goPath: `/api/store/go/${p._id}`,
  };
}

function ownerProduct(p) {
  return { ...publicProduct(p), url: p.url, status: p.status, removedReason: p.removedReason, clicks: p.clicks, lastClickedAt: p.lastClickedAt, sortOrder: p.sortOrder, createdAt: p.createdAt };
}

async function loadOwn(Model, userId, id, label) {
  assertId(id, label);
  const doc = await Model.findOne({ _id: id, owner: userId });
  if (!doc) throw ApiError.notFound(`${label} not found`);
  return doc;
}

// ---------- creator: products ----------

/** POST /api/store/me/affiliate/preview { url } — auto-fill from the product page. */
const previewLink = catchAsync(async (req, res) => {
  await storeService.requireActiveStore(req.user._id);
  const data = await linkPreview.preview(req.body.url);
  return new ApiResponse(200, data, data.found ? 'Details found' : "We couldn't read that page — fill the details yourself").send(res);
});

const listMyProducts = catchAsync(async (req, res) => {
  const store = await storeService.requireMyStore(req.user._id);
  const products = await AffiliateProduct.find({ store: store._id }).sort({ sortOrder: 1, createdAt: -1 });
  return new ApiResponse(200, products.map(ownerProduct), 'Affiliate products').send(res);
});

const createProduct = catchAsync(async (req, res) => {
  const store = await storeService.requireActiveStore(req.user._id);
  if ((await AffiliateProduct.countDocuments({ store: store._id })) >= LIMITS.AFFILIATE_PRODUCTS_MAX) {
    throw ApiError.badRequest(`You can add up to ${LIMITS.AFFILIATE_PRODUCTS_MAX} affiliate products`);
  }
  await linkPreview.assertPublicUrl(req.body.url);
  const product = await AffiliateProduct.create({
    store: store._id,
    owner: req.user._id,
    title: req.body.title,
    description: req.body.description || '',
    imageUrl: req.body.imageUrl || '',
    price: req.body.price ?? null,
    merchant: req.body.merchant || '',
    category: req.body.category || '',
    url: req.body.url,
  });
  log.info('affiliate.product_created', { productId: String(product._id) });
  return new ApiResponse(201, ownerProduct(product), 'Product added').send(res);
});

const updateProduct = catchAsync(async (req, res) => {
  const product = await loadOwn(AffiliateProduct, req.user._id, req.params.id, 'Product');
  if (product.status === AFFILIATE_STATUS.REMOVED) throw ApiError.forbidden(`Removed by Fanitt: ${product.removedReason}`);
  if (req.body.url !== undefined) await linkPreview.assertPublicUrl(req.body.url);
  ['title', 'description', 'imageUrl', 'price', 'merchant', 'category', 'url', 'sortOrder'].forEach((f) => {
    if (req.body[f] !== undefined) product[f] = req.body[f];
  });
  if (req.body.hidden !== undefined) product.status = req.body.hidden ? AFFILIATE_STATUS.HIDDEN : AFFILIATE_STATUS.ACTIVE;
  await product.save();
  return new ApiResponse(200, ownerProduct(product), 'Product updated').send(res);
});

const uploadProductImage = catchAsync(async (req, res) => {
  if (!req.file?.path) throw ApiError.badRequest('Choose an image');
  const product = await loadOwn(AffiliateProduct, req.user._id, req.params.id, 'Product');
  product.imageUrl = req.file.path;
  await product.save();
  return new ApiResponse(200, ownerProduct(product), 'Image updated').send(res);
});

const deleteProduct = catchAsync(async (req, res) => {
  const product = await loadOwn(AffiliateProduct, req.user._id, req.params.id, 'Product');
  await AffiliateCollection.updateMany({ store: product.store }, { $pull: { products: product._id } });
  await product.deleteOne();
  return new ApiResponse(200, null, 'Product deleted').send(res);
});

// ---------- creator: collections ----------

async function validProductIds(storeId, ids) {
  const unique = [...new Set((ids || []).map(String))];
  const count = await AffiliateProduct.countDocuments({ _id: { $in: unique }, store: storeId });
  if (count !== unique.length) throw ApiError.badRequest('Some products are not in your affiliate store');
  return unique;
}

const listMyCollections = catchAsync(async (req, res) => {
  const store = await storeService.requireMyStore(req.user._id);
  const collections = await AffiliateCollection.find({ store: store._id }).sort({ sortOrder: 1, createdAt: -1 });
  return new ApiResponse(200, collections, 'Collections').send(res);
});

const createCollection = catchAsync(async (req, res) => {
  const store = await storeService.requireActiveStore(req.user._id);
  if ((await AffiliateCollection.countDocuments({ store: store._id })) >= LIMITS.AFFILIATE_COLLECTIONS_MAX) {
    throw ApiError.badRequest(`You can have up to ${LIMITS.AFFILIATE_COLLECTIONS_MAX} collections`);
  }
  const collection = await AffiliateCollection.create({
    store: store._id,
    owner: req.user._id,
    title: req.body.title,
    description: req.body.description || '',
    isPublic: req.body.isPublic ?? true,
    products: await validProductIds(store._id, req.body.productIds),
  });
  return new ApiResponse(201, collection, 'Collection created').send(res);
});

const updateCollection = catchAsync(async (req, res) => {
  const collection = await loadOwn(AffiliateCollection, req.user._id, req.params.id, 'Collection');
  ['title', 'description', 'isPublic', 'sortOrder'].forEach((f) => {
    if (req.body[f] !== undefined) collection[f] = req.body[f];
  });
  if (req.body.productIds !== undefined) collection.products = await validProductIds(collection.store, req.body.productIds);
  await collection.save();
  return new ApiResponse(200, collection, 'Collection updated').send(res);
});

const uploadCollectionCover = catchAsync(async (req, res) => {
  if (!req.file?.path) throw ApiError.badRequest('Choose an image');
  const collection = await loadOwn(AffiliateCollection, req.user._id, req.params.id, 'Collection');
  collection.coverUrl = req.file.path;
  await collection.save();
  return new ApiResponse(200, collection, 'Cover updated').send(res);
});

const deleteCollection = catchAsync(async (req, res) => {
  const collection = await loadOwn(AffiliateCollection, req.user._id, req.params.id, 'Collection');
  await collection.deleteOne();
  return new ApiResponse(200, null, 'Collection deleted').send(res);
});

// ---------- creator: earnings log ----------

const listMyEarnings = catchAsync(async (req, res) => {
  const store = await storeService.requireMyStore(req.user._id);
  const { page, limit, skip } = pageParams(req.query);
  const filter = { store: store._id };
  if (Object.values(AFFILIATE_EARNING_STATUS).includes(req.query.status)) filter.status = req.query.status;
  const [earnings, total, all] = await Promise.all([
    AffiliateEarning.find(filter).populate('product', 'title imageUrl merchant').sort({ earnedAt: -1 }).skip(skip).limit(limit),
    AffiliateEarning.countDocuments(filter),
    AffiliateEarning.find({ store: store._id }).select('amount status merchant product'),
  ]);
  const totals = { pending: 0, confirmed: 0, reversed: 0 };
  const byMerchant = {};
  all.forEach((e) => {
    totals[e.status] += e.amount;
    if (e.status !== AFFILIATE_EARNING_STATUS.REVERSED) {
      const key = e.merchant || 'Other';
      byMerchant[key] = (byMerchant[key] || 0) + e.amount;
    }
  });
  return new ApiResponse(200, { earnings, totals, byMerchant, total, page, pages: Math.ceil(total / limit) }, 'Affiliate earnings').send(res);
});

async function productBelongs(storeId, productId) {
  if (!productId) return null;
  assertId(productId, 'Product');
  if (!(await AffiliateProduct.exists({ _id: productId, store: storeId }))) throw ApiError.badRequest('That product is not in your affiliate store');
  return productId;
}

const addEarning = catchAsync(async (req, res) => {
  const store = await storeService.requireActiveStore(req.user._id);
  const earning = await AffiliateEarning.create({
    store: store._id,
    owner: req.user._id,
    product: await productBelongs(store._id, req.body.productId),
    merchant: req.body.merchant || '',
    amount: req.body.amount,
    orders: req.body.orders ?? 1,
    status: req.body.status || AFFILIATE_EARNING_STATUS.PENDING,
    earnedAt: req.body.earnedAt ? new Date(req.body.earnedAt) : new Date(),
    confirmedAt: req.body.status === AFFILIATE_EARNING_STATUS.CONFIRMED ? new Date() : null,
    note: req.body.note || '',
  });
  return new ApiResponse(201, earning, 'Earning recorded').send(res);
});

const updateEarning = catchAsync(async (req, res) => {
  const earning = await loadOwn(AffiliateEarning, req.user._id, req.params.id, 'Earning');
  if (req.body.productId !== undefined) earning.product = await productBelongs(earning.store, req.body.productId);
  ['merchant', 'amount', 'orders', 'note'].forEach((f) => {
    if (req.body[f] !== undefined) earning[f] = req.body[f];
  });
  if (req.body.earnedAt !== undefined) earning.earnedAt = new Date(req.body.earnedAt);
  if (req.body.status !== undefined && req.body.status !== earning.status) {
    earning.status = req.body.status;
    earning.confirmedAt = req.body.status === AFFILIATE_EARNING_STATUS.CONFIRMED ? new Date() : null;
  }
  await earning.save();
  return new ApiResponse(200, earning, 'Earning updated').send(res);
});

const deleteEarning = catchAsync(async (req, res) => {
  const earning = await loadOwn(AffiliateEarning, req.user._id, req.params.id, 'Earning');
  await earning.deleteOne();
  return new ApiResponse(200, null, 'Earning deleted').send(res);
});

// ---------- public ----------

/** Affiliate section of a store page. */
async function storefrontFor(storeId) {
  const [products, collections] = await Promise.all([
    AffiliateProduct.find({ store: storeId, status: AFFILIATE_STATUS.ACTIVE }).sort({ sortOrder: 1, createdAt: -1 }).limit(200),
    AffiliateCollection.find({ store: storeId, isPublic: true }).sort({ sortOrder: 1, createdAt: -1 }),
  ]);
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return {
    products: products.map(publicProduct),
    collections: collections.map((c) => ({
      _id: c._id,
      title: c.title,
      description: c.description,
      coverUrl: c.coverUrl,
      products: c.products.map((id) => byId.get(String(id))).filter(Boolean).map(publicProduct),
    })),
  };
}

/** GET /api/store/go/:id — counts the click and sends the buyer to the shop. */
const go = catchAsync(async (req, res) => {
  const fallback = 'https://fanitt.com';
  if (!mongoose.isValidObjectId(req.params.id)) return res.redirect(302, fallback);
  const product = await AffiliateProduct.findById(req.params.id);
  if (!product || product.status !== AFFILIATE_STATUS.ACTIVE) return res.redirect(302, fallback);
  const store = await Store.findById(product.store).select('status user');
  if (!store || store.status !== STORE_STATUS.ACTIVE) return res.redirect(302, fallback);

  const isOwner = req.user && String(req.user._id) === String(store.user);
  if (!isOwner) await analytics.trackAffiliateClick(product, visitorKey(req));
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer-when-downgrade');
  return res.redirect(302, product.url);
});

module.exports = {
  publicProduct,
  storefrontFor,
  previewLink,
  listMyProducts,
  createProduct,
  updateProduct,
  uploadProductImage,
  deleteProduct,
  listMyCollections,
  createCollection,
  updateCollection,
  uploadCollectionCover,
  deleteCollection,
  listMyEarnings,
  addEarning,
  updateEarning,
  deleteEarning,
  go,
};
