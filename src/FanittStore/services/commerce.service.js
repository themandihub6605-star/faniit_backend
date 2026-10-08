const crypto = require('crypto');
const mongoose = require('mongoose');
const razorpay = require('../../config/razorpay');
const env = require('../../config/env');
const { User, Transaction } = require('../../models');
const walletService = require('../../services/wallet.service');
const paymentService = require('../../services/payment.service');
const ApiError = require('../../utils/apiError');
const { TRANSACTION_TYPE, TRANSACTION_STATUS } = require('../../constants/enums');
// Models are required directly (not via ../models/index.js) so this file never
// depends on the index being updated.
const Store = require('../models/Store.model');
const StoreCounter = require('../models/StoreCounter.model');
const ShopProduct = require('../models/ShopProduct.model');
const ShopCart = require('../models/ShopCart.model');
const ShopAddress = require('../models/ShopAddress.model');
const ShopOrder = require('../models/ShopOrder.model');
const { STORE_STATUS } = require('../constants');
const settingsService = require('./settings.service');
const { safeNotify } = require('./notify.service');
const { percentOf, formatRupees } = require('../utils/money');
const log = require('../utils/logger');

// Physical products: cart → checkout → orders → shipping → delivered.
//
//   checkout      one ShopOrder per seller, all sharing a checkoutId
//                 stock is reserved (decremented) right away
//     COD         → orders are `placed` at once
//     online      → `awaiting_payment` + ONE Razorpay order for the total;
//                   verify flips them to `placed`. Not paid in 30 min →
//                   `payment_failed` and the stock is put back (jobs).
//   seller        placed → confirmed → shipped (courier / tracking) → delivered
//   cancel        buyer (placed/confirmed), seller (before shipping), admin (any
//                 time before delivery) → stock back, online money refunded
//   delivered     settled exactly once:
//                   online → seller wallet gets total − fee (fee on items only)
//                   COD    → seller collected the cash, so the fee is taken
//                            from the seller wallet (may go below zero)

const {
  SHOP_ORDER_STATUS: STATUS,
  SHOP_PAYMENT_METHOD: PAYMENT_METHOD,
  SHOP_PAYMENT_STATUS: PAYMENT_STATUS,
  SHOP_PRODUCT_STATUS: P,
} = require('../shop.constants');

// Clear startup error if a model file was pasted with the wrong content.
[
  [ShopProduct, 'ShopProduct'],
  [ShopCart, 'ShopCart'],
  [ShopAddress, 'ShopAddress'],
  [ShopOrder, 'ShopOrder'],
].forEach(([model, name]) => {
  if (!model || model.modelName !== name) {
    throw new Error(`[FanittStore] src/FanittStore/models/${name}.model.js has the wrong content (it exports "${model?.modelName || 'nothing'}"). Replace it with the ${name}.model.js file.`);
  }
});
const PAYMENT_WINDOW_MS = 30 * 60 * 1000;
const MAX_QTY = 10;
const MAX_CART_LINES = 30;

// ---------- small helpers ----------

function assertId(id, label = 'Item') {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound(`${label} not found`);
}

function variantOf(product, variantId) {
  if (!product.variants.length) return null;
  if (!variantId) return undefined; // needs one, none chosen
  return product.variants.id(variantId) || undefined;
}

async function shopSettings() {
  const s = await settingsService.getSettings();
  return {
    enabled: s.shopEnabled !== false,
    feePercent: s.shopFeePercent ?? s.storeFeePercent ?? 0,
    codEnabled: s.shopCodEnabled !== false,
    onlineEnabled: s.shopOnlineEnabled !== false,
    codMaxAmount: s.shopCodMaxAmount || 0, // 0 = no limit
  };
}

function storeIsSelling(store) {
  return Boolean(store && store.status === STORE_STATUS.ACTIVE && store.isOpen);
}

// ---------- serializers ----------

function storeCard(store) {
  if (!store) return null;
  return { _id: store._id, name: store.name, slug: store.slug, logoUrl: store.logoUrl || '' };
}

function discountPercent(p) {
  return p.mrp > p.price ? Math.round(((p.mrp - p.price) / p.mrp) * 100) : 0;
}

/** Public product. `owner: true` adds the seller-only fields. */
function productView(p, { owner = false, store = null } = {}) {
  const totalStock = p.variants?.length ? p.variants.reduce((sum, v) => sum + (v.stock || 0), 0) : p.stock;
  const out = {
    _id: p._id,
    title: p.title,
    description: p.description,
    highlights: p.highlights || [],
    category: p.category,
    images: p.images || [],
    imageUrl: p.images?.[0] || '',
    mrp: p.mrp || 0,
    price: p.price,
    discountPercent: discountPercent(p),
    variantName: p.variantName || '',
    variants: (p.variants || []).map((v) => ({ _id: v._id, label: v.label, stock: v.stock, inStock: v.stock > 0 })),
    inStock: totalStock > 0,
    totalStock,
    deliveryCharge: p.deliveryCharge || 0,
    deliveryDays: p.deliveryDays || '',
    codAvailable: p.codAvailable !== false,
    returnPolicy: p.returnPolicy || '',
    salesCount: p.salesCount || 0,
    store: store ? storeCard(store) : p.store,
    seller: p.seller,
    createdAt: p.createdAt,
  };
  if (!owner) {
    // Buyers see "in stock / only N left", not exact numbers above 10.
    out.totalStock = totalStock > 10 ? null : totalStock;
    out.variants = out.variants.map((v) => ({ ...v, stock: v.stock > 10 ? null : v.stock }));
    return out;
  }
  return {
    ...out,
    status: p.status,
    removedReason: p.removedReason || '',
    views: p.views || 0,
    publishedAt: p.publishedAt,
    updatedAt: p.updatedAt,
  };
}

function orderView(o, { as = 'buyer' } = {}) {
  const out = {
    _id: o._id,
    orderNumber: o.orderNumber,
    checkoutId: o.checkoutId,
    status: o.status,
    items: o.items,
    itemCount: o.items.reduce((sum, i) => sum + i.qty, 0),
    itemsTotal: o.itemsTotal,
    deliveryCharge: o.deliveryCharge,
    total: o.total,
    address: o.address,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    courier: o.courier,
    trackingId: o.trackingId,
    trackingUrl: o.trackingUrl,
    sellerNote: o.sellerNote,
    cancelReason: o.cancelReason,
    cancelledBy: o.cancelledBy,
    timeline: o.timeline,
    placedAt: o.placedAt,
    deliveredAt: o.deliveredAt,
    createdAt: o.createdAt,
    store: o.store && o.store.name ? storeCard(o.store) : o.store,
    buyer: o.buyer && o.buyer.name ? { _id: o.buyer._id, name: o.buyer.name, avatar: o.buyer.avatar || '' } : o.buyer,
    seller: o.seller,
  };
  out.canCancel = canCancel(o, as);
  if (as === 'buyer') out.canMarkReceived = o.status === STATUS.SHIPPED;
  if (as === 'seller' || as === 'admin') {
    out.feePercent = o.feePercent;
    out.feeAmount = o.feeAmount;
    out.creatorEarning = o.creatorEarning;
    out.settledAt = o.settledAt;
    out.nextActions = sellerActions(o);
  }
  if (as === 'admin') {
    out.razorpayOrderId = o.razorpayOrderId;
    out.razorpayPaymentId = o.razorpayPaymentId;
    out.razorpayRefundId = o.razorpayRefundId;
    out.paidAt = o.paidAt;
  }
  return out;
}

function canCancel(o, as) {
  if (as === 'buyer') return [STATUS.PLACED, STATUS.CONFIRMED].includes(o.status);
  if (as === 'seller') return [STATUS.PLACED, STATUS.CONFIRMED].includes(o.status);
  return [STATUS.AWAITING_PAYMENT, STATUS.PLACED, STATUS.CONFIRMED, STATUS.SHIPPED].includes(o.status);
}

function sellerActions(o) {
  switch (o.status) {
    case STATUS.PLACED:
      return ['confirm', 'ship', 'cancel'];
    case STATUS.CONFIRMED:
      return ['ship', 'cancel'];
    case STATUS.SHIPPED:
      return ['deliver', 'update_tracking'];
    default:
      return [];
  }
}

// ---------- stock ----------

/**
 * Updates one option's stock by its array position, guarded by the option's
 * id at that position (so a seller re-ordering options in the same moment
 * can never hit the wrong one). Atomic on a single document.
 */
async function incVariantStock(productId, variantId, delta, needAtLeast = null) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const product = await ShopProduct.findById(productId).select('variants._id');
    const index = product ? product.variants.findIndex((v) => String(v._id) === String(variantId)) : -1;
    if (index < 0) return false;
    const filter = { _id: productId, [`variants.${index}._id`]: product.variants[index]._id };
    if (needAtLeast != null) filter[`variants.${index}.stock`] = { $gte: needAtLeast };
    // eslint-disable-next-line no-await-in-loop
    const res = await ShopProduct.updateOne(filter, { $inc: { [`variants.${index}.stock`]: delta } });
    if (res.modifiedCount === 1) return true;
    if (needAtLeast != null) {
      // Not enough stock — or the options moved; check which before retrying.
      // eslint-disable-next-line no-await-in-loop
      const fresh = await ShopProduct.findById(productId).select('variants');
      const v = fresh?.variants.id(variantId);
      if (!v || v.stock < needAtLeast) return false;
    }
  }
  return false;
}

/** Takes `qty` units out of stock. Returns false if not enough are left. */
async function takeStock(productId, variantId, qty) {
  if (variantId) return incVariantStock(productId, variantId, -qty, qty);
  const res = await ShopProduct.updateOne({ _id: productId, stock: { $gte: qty } }, { $inc: { stock: -qty } });
  return res.modifiedCount === 1;
}

async function putBackStock(productId, variantId, qty) {
  if (variantId) {
    // The option may have been deleted by the seller since — then there's nothing to put back.
    await incVariantStock(productId, variantId, qty);
  } else {
    await ShopProduct.updateOne({ _id: productId }, { $inc: { stock: qty } });
  }
}

async function restockOrder(order) {
  for (const item of order.items) {
    // eslint-disable-next-line no-await-in-loop
    await putBackStock(item.product, item.variant, item.qty);
  }
}

// ---------- cart ----------

async function getCartDoc(userId) {
  return (await ShopCart.findOne({ user: userId })) || new ShopCart({ user: userId, items: [] });
}

/**
 * Turns raw lines [{product, variant, qty}] into priced lines with live
 * stock checks. Lines whose product is gone stay in the list as
 * `available: false` so the app can show "no longer available".
 */
async function priceLines(lines) {
  const ids = [...new Set(lines.map((l) => String(l.product)))].filter((id) => mongoose.isValidObjectId(id));
  const products = await ShopProduct.find({ _id: { $in: ids } });
  const productMap = new Map(products.map((p) => [String(p._id), p]));
  const stores = await Store.find({ _id: { $in: [...new Set(products.map((p) => String(p.store)))] } }).select('name slug logoUrl status isOpen user');
  const storeMap = new Map(stores.map((s) => [String(s._id), s]));

  return lines.map((line) => {
    const p = productMap.get(String(line.product));
    const store = p ? storeMap.get(String(p.store)) : null;
    const base = { _id: line._id, productId: line.product, variantId: line.variant || null, qty: line.qty };
    if (!p || p.status !== P.PUBLISHED || !storeIsSelling(store)) {
      return { ...base, available: false, problem: 'This product is no longer available', title: p?.title || 'Product', imageUrl: p?.images?.[0] || '' };
    }
    const v = variantOf(p, line.variant);
    if (v === undefined) {
      return { ...base, available: false, problem: `Choose a ${(p.variantName || 'option').toLowerCase()}`, title: p.title, imageUrl: p.images[0] || '' };
    }
    const stock = v ? v.stock : p.stock;
    const problem = stock <= 0 ? 'Out of stock' : stock < line.qty ? `Only ${stock} left` : '';
    return {
      ...base,
      variantId: v ? v._id : null, // ignore an option sent for a product that has none
      available: !problem,
      problem,
      stock,
      product: p,
      store,
      title: p.title,
      imageUrl: p.images[0] || '',
      variantLabel: v ? v.label : '',
      variantName: v ? p.variantName : '',
      price: p.price,
      mrp: p.mrp || 0,
      deliveryCharge: p.deliveryCharge || 0,
      codAvailable: p.codAvailable !== false,
      lineTotal: p.price * line.qty,
    };
  });
}

/** Groups priced lines by seller and adds totals — what cart & checkout show. */
function summarize(priced, settings) {
  const groups = new Map();
  for (const line of priced) {
    if (!line.available) continue;
    const key = String(line.store._id);
    if (!groups.has(key)) groups.set(key, { store: line.store, lines: [] });
    groups.get(key).lines.push(line);
  }
  const sellers = [...groups.values()].map((g) => {
    const itemsTotal = g.lines.reduce((sum, l) => sum + l.lineTotal, 0);
    // One parcel per seller: the highest delivery charge among its items.
    const deliveryCharge = Math.max(0, ...g.lines.map((l) => l.deliveryCharge));
    return {
      store: storeCard(g.store),
      itemsTotal,
      deliveryCharge,
      total: itemsTotal + deliveryCharge,
      codAvailable: g.lines.every((l) => l.codAvailable),
      lines: g.lines,
    };
  });
  const itemsTotal = sellers.reduce((s, g) => s + g.itemsTotal, 0);
  const mrpTotal = priced.filter((l) => l.available).reduce((s, l) => s + Math.max(l.mrp, l.price) * l.qty, 0);
  const deliveryCharge = sellers.reduce((s, g) => s + g.deliveryCharge, 0);
  const total = itemsTotal + deliveryCharge;

  let codAvailable = settings.codEnabled && sellers.length > 0 && sellers.every((g) => g.codAvailable);
  let codNote = '';
  if (!settings.codEnabled) codNote = 'Cash on Delivery is not available right now';
  else if (!sellers.every((g) => g.codAvailable)) codNote = 'Some items in your order are not available for Cash on Delivery';
  else if (settings.codMaxAmount && total > settings.codMaxAmount) {
    codAvailable = false;
    codNote = `Cash on Delivery is available for orders up to ${formatRupees(settings.codMaxAmount)}`;
  }

  return {
    sellers,
    itemCount: priced.filter((l) => l.available).reduce((s, l) => s + l.qty, 0),
    mrpTotal,
    itemsTotal,
    savings: Math.max(0, mrpTotal - itemsTotal),
    deliveryCharge,
    total,
    codAvailable,
    codNote,
    onlineAvailable: settings.onlineEnabled,
  };
}

function lineView(l) {
  return {
    _id: l._id,
    productId: l.productId,
    variantId: l.variantId,
    qty: l.qty,
    available: l.available,
    problem: l.problem || '',
    title: l.title,
    imageUrl: l.imageUrl,
    variantLabel: l.variantLabel || '',
    variantName: l.variantName || '',
    price: l.price || 0,
    mrp: l.mrp || 0,
    lineTotal: l.lineTotal || 0,
    stock: l.stock == null ? null : l.stock > 10 ? null : l.stock,
    store: l.store ? storeCard(l.store) : null,
  };
}

function summaryView(summary) {
  return {
    ...summary,
    sellers: summary.sellers.map((g) => ({ ...g, lines: g.lines.map(lineView) })),
  };
}

async function cartView(userId) {
  const cart = await getCartDoc(userId);
  const priced = await priceLines(cart.items);
  const settings = await shopSettings();
  return {
    items: priced.map(lineView),
    count: cart.items.reduce((s, i) => s + i.qty, 0),
    summary: summaryView(summarize(priced, settings)),
  };
}

async function addToCart(userId, { productId, variantId = null, qty = 1 }) {
  assertId(productId, 'Product');
  const product = await ShopProduct.findById(productId);
  if (!product || product.status !== P.PUBLISHED) throw ApiError.notFound('This product is not available');
  if (String(product.seller) === String(userId)) throw ApiError.badRequest("You can't buy your own product");
  const store = await Store.findById(product.store).select('status isOpen');
  if (!storeIsSelling(store)) throw ApiError.badRequest('This store is not taking orders right now');
  const v = variantOf(product, variantId);
  if (v === undefined) throw ApiError.badRequest(`Choose a ${(product.variantName || 'option').toLowerCase()}`, 'VARIANT_REQUIRED');
  const vid = v ? v._id : null;

  const cart = await getCartDoc(userId);
  const existing = cart.items.find((i) => String(i.product) === String(product._id) && String(i.variant || '') === String(vid || ''));
  const wanted = Math.min(MAX_QTY, (existing ? existing.qty : 0) + qty);
  const stock = v ? v.stock : product.stock;
  if (stock <= 0) throw ApiError.badRequest('This product is out of stock', 'OUT_OF_STOCK');
  if (wanted > stock) throw ApiError.badRequest(`Only ${stock} left in stock`, 'OUT_OF_STOCK');

  if (existing) existing.qty = wanted;
  else {
    if (cart.items.length >= MAX_CART_LINES) throw ApiError.badRequest('Your cart is full — check out or remove something first');
    cart.items.push({ product: product._id, variant: vid, qty: wanted });
  }
  await cart.save();
  return cartView(userId);
}

async function updateCartItem(userId, itemId, qty) {
  const cart = await getCartDoc(userId);
  const item = cart.items.id(itemId);
  if (!item) throw ApiError.notFound('This item is not in your cart');
  if (qty <= 0) item.deleteOne();
  else {
    const product = await ShopProduct.findById(item.product);
    const stock = product ? product.stockFor(item.variant) : 0;
    if (product && qty > stock) throw ApiError.badRequest(stock > 0 ? `Only ${stock} left in stock` : 'This product is out of stock', 'OUT_OF_STOCK');
    item.qty = Math.min(MAX_QTY, qty);
  }
  await cart.save();
  return cartView(userId);
}

async function removeCartItem(userId, itemId) {
  await ShopCart.updateOne({ user: userId }, { $pull: { items: { _id: itemId } } });
  return cartView(userId);
}

async function clearCart(userId) {
  await ShopCart.updateOne({ user: userId }, { $set: { items: [] } });
  return cartView(userId);
}

async function cartCount(userId) {
  const cart = await ShopCart.findOne({ user: userId }).select('items.qty');
  return cart ? cart.items.reduce((s, i) => s + i.qty, 0) : 0;
}

// ---------- addresses ----------

async function listAddresses(userId) {
  return ShopAddress.find({ user: userId }).sort({ isDefault: -1, updatedAt: -1 });
}

async function saveAddress(userId, data, addressId = null) {
  let address;
  if (addressId) {
    assertId(addressId, 'Address');
    address = await ShopAddress.findOne({ _id: addressId, user: userId });
    if (!address) throw ApiError.notFound('Address not found');
    Object.assign(address, data);
  } else {
    if ((await ShopAddress.countDocuments({ user: userId })) >= 10) throw ApiError.badRequest('You can save up to 10 addresses');
    const isFirst = !(await ShopAddress.exists({ user: userId }));
    address = new ShopAddress({ ...data, user: userId, isDefault: isFirst || Boolean(data.isDefault) });
  }
  if (address.isDefault) await ShopAddress.updateMany({ user: userId, _id: { $ne: address._id } }, { $set: { isDefault: false } });
  await address.save();
  return address;
}

async function setDefaultAddress(userId, addressId) {
  assertId(addressId, 'Address');
  const address = await ShopAddress.findOne({ _id: addressId, user: userId });
  if (!address) throw ApiError.notFound('Address not found');
  await ShopAddress.updateMany({ user: userId }, { $set: { isDefault: false } });
  address.isDefault = true;
  await address.save();
  return address;
}

async function deleteAddress(userId, addressId) {
  assertId(addressId, 'Address');
  const address = await ShopAddress.findOneAndDelete({ _id: addressId, user: userId });
  if (!address) throw ApiError.notFound('Address not found');
  if (address.isDefault) {
    const next = await ShopAddress.findOne({ user: userId }).sort({ updatedAt: -1 });
    if (next) await ShopAddress.updateOne({ _id: next._id }, { $set: { isDefault: true } });
  }
}

// ---------- checkout ----------

/** Lines to buy: the whole cart, or one product ("Buy now"). */
async function checkoutLines(userId, { source, productId, variantId, qty }) {
  if (source === 'buy_now') {
    assertId(productId, 'Product');
    return [{ _id: null, product: productId, variant: variantId || null, qty: qty || 1 }];
  }
  const cart = await getCartDoc(userId);
  if (!cart.items.length) throw ApiError.badRequest('Your cart is empty');
  return cart.items.map((i) => ({ _id: i._id, product: i.product, variant: i.variant, qty: i.qty }));
}

/** Price breakdown before paying (no stock is reserved). */
async function previewCheckout(userId, input) {
  const lines = await checkoutLines(userId, input);
  const priced = await priceLines(lines);
  const settings = await shopSettings();
  const summary = summarize(priced, settings);
  return {
    ...summaryView(summary),
    unavailable: priced.filter((l) => !l.available).map(lineView),
  };
}

async function newOrderNumber() {
  const year = new Date().getFullYear();
  const seq = await StoreCounter.next(`shop-order-${year}`);
  return `FS${String(year).slice(-2)}${String(seq).padStart(6, '0')}`;
}

function addressSnapshot(a) {
  return { name: a.name, phone: a.phone, line1: a.line1, line2: a.line2, landmark: a.landmark, city: a.city, state: a.state, pincode: a.pincode };
}

/**
 * Places the order(s). Returns { checkoutId, orders, paid, razorpay }.
 * input: { source: 'cart'|'buy_now', productId?, variantId?, qty?, addressId, paymentMethod }
 */
async function checkout(buyer, input) {
  const settings = await shopSettings();
  if (!settings.enabled) throw ApiError.badRequest('Shopping is paused right now — please try again later', 'SHOP_PAUSED');
  const method = input.paymentMethod;
  if (method === PAYMENT_METHOD.COD && !settings.codEnabled) throw ApiError.badRequest('Cash on Delivery is not available right now');
  if (method === PAYMENT_METHOD.ONLINE && !settings.onlineEnabled) throw ApiError.badRequest('Online payment is not available right now');

  assertId(input.addressId, 'Address');
  const address = await ShopAddress.findOne({ _id: input.addressId, user: buyer._id });
  if (!address) throw ApiError.badRequest('Choose a delivery address');

  const lines = await checkoutLines(buyer._id, input);
  const priced = await priceLines(lines);
  const bad = priced.find((l) => !l.available);
  if (bad) throw ApiError.badRequest(`${bad.title}: ${bad.problem}`, 'CART_CHANGED');
  if (priced.some((l) => String(l.product.seller) === String(buyer._id))) throw ApiError.badRequest("You can't buy your own product");

  const summary = summarize(priced, settings);
  if (!summary.sellers.length) throw ApiError.badRequest('Nothing to buy');
  if (method === PAYMENT_METHOD.COD && !summary.codAvailable) throw ApiError.badRequest(summary.codNote || 'Cash on Delivery is not available for this order');

  // Reserve stock for every line; undo everything if one fails.
  const taken = [];
  for (const line of priced) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await takeStock(line.product._id, line.variantId, line.qty);
    if (!ok) {
      // eslint-disable-next-line no-await-in-loop
      for (const t of taken) await putBackStock(t.product._id, t.variantId, t.qty);
      throw ApiError.badRequest(`${line.title} just went out of stock`, 'CART_CHANGED');
    }
    taken.push(line);
  }

  const checkoutId = `CK${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const isCod = method === PAYMENT_METHOD.COD;
  const now = new Date();
  let orders = [];
  try {
    for (const group of summary.sellers) {
      // eslint-disable-next-line no-await-in-loop
      const orderNumber = await newOrderNumber();
      const store = group.lines[0].store;
      // eslint-disable-next-line no-await-in-loop
      const order = await ShopOrder.create({
        orderNumber,
        checkoutId,
        fromCart: input.source !== 'buy_now',
        buyer: buyer._id,
        seller: store.user,
        store: store._id,
        items: group.lines.map((l) => ({
          product: l.product._id,
          title: l.title,
          imageUrl: l.imageUrl,
          variant: l.variantId,
          variantLabel: l.variantLabel,
          variantName: l.variantName,
          price: l.price,
          mrp: l.mrp,
          qty: l.qty,
        })),
        itemsTotal: group.itemsTotal,
        deliveryCharge: group.deliveryCharge,
        total: group.total,
        address: addressSnapshot(address),
        paymentMethod: method,
        paymentStatus: PAYMENT_STATUS.PENDING,
        status: isCod ? STATUS.PLACED : STATUS.AWAITING_PAYMENT,
        placedAt: isCod ? now : null,
        timeline: [{ status: isCod ? STATUS.PLACED : STATUS.AWAITING_PAYMENT, at: now, by: 'buyer' }],
      });
      orders.push(order);
    }
  } catch (err) {
    for (const t of taken) await putBackStock(t.product._id, t.variantId, t.qty); // eslint-disable-line no-await-in-loop
    await ShopOrder.deleteMany({ checkoutId });
    throw err;
  }

  log.info('shop.checkout', { checkoutId, buyerId: String(buyer._id), method, orders: orders.length, total: summary.total });

  if (isCod) {
    await afterPlaced(orders);
    return { checkoutId, orders, paid: false, placed: true, razorpay: null };
  }

  let rzp;
  try {
    rzp = await paymentService.createOrder(summary.total, `shop_${checkoutId}`.slice(0, 40), {
      shopCheckoutId: checkoutId,
      buyerId: String(buyer._id),
    });
  } catch (err) {
    for (const o of orders) await failOrder(o, 'Could not start the payment'); // eslint-disable-line no-await-in-loop
    log.error('shop.razorpay_create_failed', err, { checkoutId });
    throw ApiError.badRequest('Could not start the payment. Please try again.');
  }
  await ShopOrder.updateMany({ checkoutId }, { $set: { razorpayOrderId: rzp.id } });
  orders = await ShopOrder.find({ checkoutId });

  return {
    checkoutId,
    orders,
    paid: false,
    placed: false,
    razorpay: {
      keyId: env.razorpay.keyId,
      orderId: rzp.id,
      amount: summary.total,
      currency: 'INR',
      name: 'Fanitt Store',
      description: orders.length === 1 ? `Order ${orders[0].orderNumber}` : `${orders.length} orders`,
      prefill: { name: buyer.name || '', email: buyer.email || '', contact: buyer.phone || address.phone || '' },
    },
  };
}

/** Cart cleanup + notifications once orders are placed (COD now, online after paying). */
async function afterPlaced(orders) {
  if (!orders.length) return;
  const buyerId = orders[0].buyer;
  if (orders.some((o) => o.fromCart)) {
    const pulls = orders.flatMap((o) => o.items.map((i) => ({ product: i.product, variant: i.variant || null })));
    const cart = await ShopCart.findOne({ user: buyerId });
    if (cart) {
      cart.items = cart.items.filter(
        (ci) => !pulls.some((p) => String(p.product) === String(ci.product) && String(p.variant || '') === String(ci.variant || ''))
      );
      await cart.save();
    }
  }
  const total = orders.reduce((s, o) => s + o.total, 0);
  const isCod = orders[0].paymentMethod === PAYMENT_METHOD.COD;
  await safeNotify({
    userId: buyerId,
    type: 'store_order',
    title: 'Order placed 🎉',
    message:
      orders.length === 1
        ? `Order ${orders[0].orderNumber} is placed. ${isCod ? `Pay ${formatRupees(total)} on delivery.` : 'Payment received.'}`
        : `${orders.length} orders are placed. ${isCod ? `Pay ${formatRupees(total)} on delivery.` : 'Payment received.'}`,
    relatedModel: 'ShopOrder',
    relatedId: orders[0]._id,
  });
  await Promise.all(
    orders.map((o) =>
      safeNotify({
        userId: o.seller,
        fromUser: o.buyer,
        type: 'store_sale',
        title: `New order — ${formatRupees(o.total)}`,
        message: `${o.items[0].title}${o.items.length > 1 ? ` + ${o.items.length - 1} more` : ''} · ${isCod ? 'Cash on Delivery' : 'Paid online'}. Confirm and ship it soon.`,
        relatedModel: 'ShopOrder',
        relatedId: o._id,
      })
    )
  );
}

/** Flips every awaiting order of a checkout to placed (exactly once). */
async function markCheckoutPaid(checkoutId, razorpayPaymentId) {
  const now = new Date();
  const res = await ShopOrder.updateMany(
    { checkoutId, status: STATUS.AWAITING_PAYMENT },
    {
      $set: { status: STATUS.PLACED, paymentStatus: PAYMENT_STATUS.PAID, razorpayPaymentId, paidAt: now, placedAt: now },
      $push: { timeline: { status: STATUS.PLACED, at: now, by: 'system', note: 'Payment received' } },
    }
  );
  const orders = await ShopOrder.find({ checkoutId });
  if (res.modifiedCount > 0) {
    log.info('shop.paid', { checkoutId, razorpayPaymentId, orders: res.modifiedCount });
    await afterPlaced(orders.filter((o) => o.status === STATUS.PLACED));
  }
  return orders;
}

/** Confirms the online payment of a checkout. Safe to call more than once. */
async function verifyCheckout(buyerId, checkoutId, { razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const orders = await ShopOrder.find({ checkoutId, buyer: buyerId });
  if (!orders.length) throw ApiError.notFound('Order not found');
  if (orders[0].paymentMethod !== PAYMENT_METHOD.ONLINE || orders[0].razorpayOrderId !== razorpayOrderId) {
    throw ApiError.badRequest('Payment does not belong to this order');
  }
  if (orders.every((o) => o.paymentStatus === PAYMENT_STATUS.PAID || o.paymentStatus === PAYMENT_STATUS.REFUNDED)) return orders;

  if (!paymentService.verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature })) {
    log.warn('shop.bad_signature', { checkoutId, razorpayOrderId });
    throw ApiError.badRequest('Payment verification failed');
  }
  const expected = orders.reduce((s, o) => s + o.total, 0);
  const rzpOrder = await razorpay.orders.fetch(razorpayOrderId);
  if (!rzpOrder || rzpOrder.status !== 'paid' || Number(rzpOrder.amount_paid) !== expected) {
    throw ApiError.badRequest('Payment is not complete yet — if money was deducted it will be confirmed shortly');
  }

  if (orders.some((o) => o.status === STATUS.PAYMENT_FAILED)) {
    // Paid after the 30-minute window closed and stock was released — refund.
    await refundLatePayment(orders, razorpayPaymentId);
    throw ApiError.badRequest('This payment came in too late and will be refunded in 5–7 working days. Please order again.', 'PAYMENT_TOO_LATE');
  }
  return markCheckoutPaid(checkoutId, razorpayPaymentId);
}

async function refundLatePayment(orders, razorpayPaymentId) {
  const amount = orders.reduce((s, o) => s + o.total, 0);
  try {
    const refund = await razorpay.payments.refund(razorpayPaymentId, { amount, notes: { shopCheckoutId: orders[0].checkoutId, reason: 'Paid after the payment window' } });
    await ShopOrder.updateMany(
      { checkoutId: orders[0].checkoutId },
      { $set: { paymentStatus: PAYMENT_STATUS.REFUNDED, razorpayPaymentId, razorpayRefundId: refund?.id || '' } }
    );
    log.info('shop.late_payment_refunded', { checkoutId: orders[0].checkoutId, amount });
  } catch (err) {
    log.error('shop.late_refund_failed', err, { checkoutId: orders[0].checkoutId, razorpayPaymentId });
  }
}

async function failOrder(order, note) {
  const failed = await ShopOrder.findOneAndUpdate(
    { _id: order._id, status: STATUS.AWAITING_PAYMENT },
    {
      $set: { status: STATUS.PAYMENT_FAILED, paymentStatus: PAYMENT_STATUS.FAILED },
      $push: { timeline: { status: STATUS.PAYMENT_FAILED, at: new Date(), by: 'system', note } },
    },
    { new: true }
  );
  if (failed) await restockOrder(failed);
  return failed;
}

/** Job: online checkouts not paid within 30 minutes. Asks Razorpay first. */
async function expireUnpaid() {
  const stale = await ShopOrder.find({ status: STATUS.AWAITING_PAYMENT, createdAt: { $lt: new Date(Date.now() - PAYMENT_WINDOW_MS) } })
    .sort({ createdAt: 1 })
    .limit(50);
  const seen = new Set();
  for (const order of stale) {
    if (seen.has(order.checkoutId)) continue;
    seen.add(order.checkoutId);
    try {
      let paidPaymentId = '';
      if (order.razorpayOrderId) {
        // eslint-disable-next-line no-await-in-loop
        const rzp = await razorpay.orders.fetch(order.razorpayOrderId).catch(() => null);
        if (rzp?.status === 'paid') {
          // eslint-disable-next-line no-await-in-loop
          const payments = await razorpay.orders.fetchPayments(order.razorpayOrderId).catch(() => null);
          paidPaymentId = (payments?.items || []).find((p) => p.status === 'captured')?.id || '';
        }
      }
      if (paidPaymentId) {
        // eslint-disable-next-line no-await-in-loop
        await markCheckoutPaid(order.checkoutId, paidPaymentId);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const group = await ShopOrder.find({ checkoutId: order.checkoutId, status: STATUS.AWAITING_PAYMENT });
      // eslint-disable-next-line no-await-in-loop
      for (const o of group) await failOrder(o, 'Payment not completed in 30 minutes');
      log.info('shop.checkout_expired', { checkoutId: order.checkoutId });
    } catch (err) {
      log.error('shop.expire_failed', err, { checkoutId: order.checkoutId });
    }
  }
}

// ---------- order status changes ----------

async function pushStatus(order, status, by, note = '', extra = {}) {
  const updated = await ShopOrder.findOneAndUpdate(
    { _id: order._id, status: order.status },
    { $set: { status, ...extra }, $push: { timeline: { status, at: new Date(), by, note } } },
    { new: true }
  );
  if (!updated) throw ApiError.conflict('This order was just updated — refresh and try again');
  return updated;
}

const STATUS_TEXT = {
  [STATUS.CONFIRMED]: (o) => ({ title: 'Order confirmed', message: `The seller confirmed order ${o.orderNumber}. It will be shipped soon.` }),
  [STATUS.SHIPPED]: (o) => ({
    title: 'Order shipped 🚚',
    message: `Order ${o.orderNumber} is on its way${o.courier ? ` with ${o.courier}` : ''}${o.trackingId ? ` (tracking ${o.trackingId})` : ''}.`,
  }),
  [STATUS.DELIVERED]: (o) => ({ title: 'Order delivered ✅', message: `Order ${o.orderNumber} was delivered. Enjoy!` }),
};

async function notifyBuyer(order) {
  const text = STATUS_TEXT[order.status]?.(order);
  if (!text) return;
  await safeNotify({ userId: order.buyer, type: 'store_order', ...text, relatedModel: 'ShopOrder', relatedId: order._id });
}

async function loadSellerOrder(sellerId, orderId) {
  assertId(orderId, 'Order');
  const order = await ShopOrder.findOne({ _id: orderId, seller: sellerId });
  if (!order) throw ApiError.notFound('Order not found');
  return order;
}

async function sellerConfirm(sellerId, orderId) {
  const order = await loadSellerOrder(sellerId, orderId);
  if (order.status !== STATUS.PLACED) throw ApiError.badRequest(`This order is ${order.status.replace('_', ' ')}`);
  const updated = await pushStatus(order, STATUS.CONFIRMED, 'seller');
  await notifyBuyer(updated);
  return updated;
}

async function sellerShip(sellerId, orderId, { courier = '', trackingId = '', trackingUrl = '', note = '' }) {
  const order = await loadSellerOrder(sellerId, orderId);
  const extra = { courier, trackingId, trackingUrl, sellerNote: note || order.sellerNote };
  if (order.status === STATUS.SHIPPED) {
    // Just updating the tracking details.
    Object.assign(order, extra);
    await order.save();
    return order;
  }
  if (![STATUS.PLACED, STATUS.CONFIRMED].includes(order.status)) throw ApiError.badRequest(`This order is ${order.status.replace('_', ' ')}`);
  const updated = await pushStatus(order, STATUS.SHIPPED, 'seller', note, extra);
  await notifyBuyer(updated);
  return updated;
}

async function markDelivered(order, by) {
  if (order.status !== STATUS.SHIPPED) throw ApiError.badRequest('Only shipped orders can be marked delivered');
  const extra = { deliveredAt: new Date() };
  if (order.paymentMethod === PAYMENT_METHOD.COD) {
    extra.paymentStatus = PAYMENT_STATUS.PAID;
    extra.paidAt = new Date();
  }
  const updated = await pushStatus(order, STATUS.DELIVERED, by, by === 'buyer' ? 'Buyer confirmed delivery' : '', extra);
  await settleOrder(updated._id);
  await Promise.all(
    updated.items.map((i) => ShopProduct.updateOne({ _id: i.product }, { $inc: { salesCount: i.qty } }))
  );
  await notifyBuyer(updated);
  return ShopOrder.findById(updated._id);
}

async function sellerDeliver(sellerId, orderId) {
  return markDelivered(await loadSellerOrder(sellerId, orderId), 'seller');
}

async function buyerReceived(buyerId, orderId) {
  assertId(orderId, 'Order');
  const order = await ShopOrder.findOne({ _id: orderId, buyer: buyerId });
  if (!order) throw ApiError.notFound('Order not found');
  return markDelivered(order, 'buyer');
}

/**
 * Pays the seller for a delivered order, exactly once.
 * Fee = shop fee % of the items total (delivery charge is not charged).
 */
async function settleOrder(orderId) {
  const order = await ShopOrder.findOneAndUpdate(
    { _id: orderId, status: STATUS.DELIVERED, settledAt: null },
    { $set: { settledAt: new Date() } },
    { new: true }
  );
  if (!order) return null;
  const { feePercent } = await shopSettings();
  const feeAmount = percentOf(order.itemsTotal, feePercent);

  try {
    const store = await Store.findById(order.store).select('creator');
    if (order.paymentMethod === PAYMENT_METHOD.ONLINE) {
      const afterFee = Math.max(0, order.total - feeAmount);
      let agencyCommission = 0;
      let referralCommission = 0;
      let creatorEarning = afterFee;
      if (afterFee > 0 && store?.creator) {
        const split = await walletService.splitEarnings(afterFee, store.creator, 'ShopOrder', order._id);
        agencyCommission = split.agencyCommission;
        referralCommission = split.referralCommission;
        creatorEarning = split.netAmount;
        await walletService.creditCreator(store.creator, creatorEarning);
        await User.updateOne({ _id: order.seller }, { $inc: { walletFeeExempt: creatorEarning } });
      }
      await Transaction.create({
        type: TRANSACTION_TYPE.STORE_SALE,
        status: TRANSACTION_STATUS.SUCCESS,
        from: order.buyer,
        to: order.seller,
        amount: order.total,
        platformCommission: feeAmount,
        agencyCommission,
        referralCommission,
        netAmount: creatorEarning,
        relatedModel: 'ShopOrder',
        relatedId: order._id,
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: order.razorpayPaymentId,
        notes: `Shop order ${order.orderNumber}`,
      });
      order.creatorEarning = creatorEarning;
      await safeNotify({
        userId: order.seller,
        type: 'store_sale',
        title: `${formatRupees(creatorEarning)} added to your wallet`,
        message: `Order ${order.orderNumber} was delivered.`,
        relatedModel: 'ShopOrder',
        relatedId: order._id,
      });
    } else {
      // COD: the seller already has the cash. Fanitt's fee comes from the wallet.
      if (feeAmount > 0) {
        await User.updateOne({ _id: order.seller }, { $inc: { walletBalance: -feeAmount } });
        await Transaction.create({
          type: TRANSACTION_TYPE.PLATFORM_COMMISSION,
          status: TRANSACTION_STATUS.SUCCESS,
          from: order.seller,
          to: null,
          amount: feeAmount,
          platformCommission: feeAmount,
          netAmount: -feeAmount,
          relatedModel: 'ShopOrder',
          relatedId: order._id,
          notes: `Fanitt fee (${feePercent}%) for COD order ${order.orderNumber}`,
        });
      }
      order.creatorEarning = order.total - feeAmount;
    }
    order.feePercent = feePercent;
    order.feeAmount = feeAmount;
    await order.save();
    await Store.updateOne(
      { _id: order.store },
      { $inc: { 'stats.orders': 1, 'stats.grossSales': order.total, 'stats.feesPaid': feeAmount, 'stats.netEarnings': order.creatorEarning } }
    );
    log.info('shop.settled', { orderId: String(order._id), method: order.paymentMethod, total: order.total, feeAmount, creatorEarning: order.creatorEarning });
    return order;
  } catch (err) {
    // settledAt stays set — this line has everything needed to finish by hand.
    log.error('shop.settle_failed', err, { orderId: String(order._id), sellerId: String(order.seller), total: order.total });
    return null;
  }
}

/**
 * Cancels an order: stock back; if paid online, the order's amount is
 * refunded to the buyer through Razorpay.
 */
async function cancelOrder(order, { by, reason }) {
  if (!canCancel(order, by)) {
    if (order.status === STATUS.SHIPPED) throw ApiError.badRequest('This order is already shipped and can no longer be cancelled');
    throw ApiError.badRequest(`This order is ${order.status.replace('_', ' ')} and can't be cancelled`);
  }
  const wasPaidOnline = order.paymentMethod === PAYMENT_METHOD.ONLINE && order.paymentStatus === PAYMENT_STATUS.PAID;
  const updated = await pushStatus(order, STATUS.CANCELLED, by, reason, { cancelReason: reason, cancelledBy: by });
  await restockOrder(updated);

  if (wasPaidOnline && updated.razorpayPaymentId) {
    try {
      const refund = await razorpay.payments.refund(updated.razorpayPaymentId, {
        amount: updated.total,
        notes: { shopOrderId: String(updated._id), reason: String(reason).slice(0, 200) },
      });
      updated.paymentStatus = PAYMENT_STATUS.REFUNDED;
      updated.razorpayRefundId = refund?.id || '';
      await updated.save();
    } catch (err) {
      // Cancelled but not refunded — admin sees paymentStatus "paid" on a cancelled order and can retry.
      log.error('shop.refund_failed', err, { orderId: String(updated._id), paymentId: updated.razorpayPaymentId });
    }
  } else if (updated.status === STATUS.CANCELLED && order.status === STATUS.AWAITING_PAYMENT) {
    updated.paymentStatus = PAYMENT_STATUS.FAILED;
    await updated.save();
  }

  const refundText = updated.paymentStatus === PAYMENT_STATUS.REFUNDED ? ` ${formatRupees(updated.total)} will be refunded in 5–7 working days.` : '';
  const who = { buyer: 'You cancelled', seller: 'The seller cancelled', admin: 'Fanitt cancelled', system: 'We cancelled' }[by];
  await Promise.all([
    safeNotify({
      userId: updated.buyer,
      type: 'store_order',
      title: 'Order cancelled',
      message: `${who} order ${updated.orderNumber}${by !== 'buyer' && reason ? `: ${reason}` : '.'}${refundText}`,
      relatedModel: 'ShopOrder',
      relatedId: updated._id,
    }),
    by !== 'seller'
      ? safeNotify({
          userId: updated.seller,
          type: 'store_sale',
          title: 'Order cancelled',
          message: `Order ${updated.orderNumber} was cancelled by ${by === 'buyer' ? 'the buyer' : 'Fanitt'}${reason ? `: ${reason}` : '.'}`,
          relatedModel: 'ShopOrder',
          relatedId: updated._id,
        })
      : null,
  ]);
  log.info('shop.cancelled', { orderId: String(updated._id), by, refunded: updated.paymentStatus === PAYMENT_STATUS.REFUNDED });
  return updated;
}

/** Admin: retry a refund that failed on a cancelled online order. */
async function retryRefund(orderId) {
  assertId(orderId, 'Order');
  const order = await ShopOrder.findById(orderId);
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status !== STATUS.CANCELLED || order.paymentStatus !== PAYMENT_STATUS.PAID || !order.razorpayPaymentId) {
    throw ApiError.badRequest('Nothing to refund on this order');
  }
  try {
    const refund = await razorpay.payments.refund(order.razorpayPaymentId, { amount: order.total, notes: { shopOrderId: String(order._id) } });
    order.paymentStatus = PAYMENT_STATUS.REFUNDED;
    order.razorpayRefundId = refund?.id || '';
    await order.save();
    return order;
  } catch (err) {
    const detail = err?.error?.description || err?.message || 'Razorpay refused the refund';
    throw ApiError.badRequest(`Refund failed: ${detail}`);
  }
}

module.exports = {
  STATUS,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  shopSettings,
  storeIsSelling,
  storeCard,
  productView,
  orderView,
  // cart
  cartView,
  addToCart,
  updateCartItem,
  removeCartItem,
  clearCart,
  cartCount,
  // addresses
  listAddresses,
  saveAddress,
  setDefaultAddress,
  deleteAddress,
  // checkout
  previewCheckout,
  checkout,
  verifyCheckout,
  expireUnpaid,
  // orders
  sellerConfirm,
  sellerShip,
  sellerDeliver,
  buyerReceived,
  cancelOrder,
  settleOrder,
  retryRefund,
};