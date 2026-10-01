const { Store, StoreOrder, StoreDailyStat, StoreVisit, AffiliateProduct, AffiliateEarning, AffiliateClick, LiveStream, CallSession } = require('../models');
const { ORDER_STATUS, ORDER_ITEM, CALL_STATUS, AFFILIATE_EARNING_STATUS } = require('../constants');
const log = require('../utils/logger');

// Store analytics. Totals are computed in JS over the chosen date range
// (orders are fetched with only the fields needed), which keeps the maths
// easy to read and identical on every MongoDB version.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const SOURCES = [ORDER_ITEM.DIGITAL_PRODUCT, ORDER_ITEM.LIVE_STREAM, ORDER_ITEM.CALL, ORDER_ITEM.FANBOX];

/** India calendar day "YYYY-MM-DD" for a date. */
function istDay(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Start of the range: midnight India time, `days - 1` days ago. */
function rangeStart(days) {
  const today = istDay();
  const startIstMidnightUtc = new Date(`${today}T00:00:00.000Z`).getTime() - IST_OFFSET_MS;
  return new Date(startIstMidnightUtc - (days - 1) * 24 * 60 * 60 * 1000);
}

function emptyDays(from, days) {
  const map = new Map();
  for (let i = 0; i < days; i += 1) {
    const d = istDay(new Date(from.getTime() + i * 24 * 60 * 60 * 1000));
    map.set(d, { date: d, gross: 0, net: 0, orders: 0, views: 0, visitors: 0, affiliateClicks: 0 });
  }
  return map;
}

/** Gross actually charged for an order (calls: the billed part only). */
function grossOf(o) {
  if (o.itemType === ORDER_ITEM.CALL) return o.settledAmount || 0;
  return o.amount;
}

// ---------- tracking (never throws) ----------

async function trackStoreView(storeId, visitorKey) {
  try {
    const day = istDay();
    await StoreDailyStat.updateOne({ store: storeId, day }, { $inc: { views: 1 } }, { upsert: true });
    if (visitorKey) {
      await StoreVisit.create({ store: storeId, day, visitor: visitorKey }).catch((err) => {
        if (err?.code !== 11000) throw err; // already counted today
      });
    }
  } catch (err) {
    log.warn('analytics.track_view_failed', { storeId: String(storeId), message: err?.message });
  }
}

async function trackProductView(storeId) {
  try {
    await StoreDailyStat.updateOne({ store: storeId, day: istDay() }, { $inc: { productViews: 1 } }, { upsert: true });
  } catch (err) {
    log.warn('analytics.track_product_view_failed', { storeId: String(storeId), message: err?.message });
  }
}

async function trackAffiliateClick(product, visitorKey) {
  try {
    const day = istDay();
    await Promise.all([
      AffiliateProduct.updateOne({ _id: product._id }, { $inc: { clicks: 1 }, $set: { lastClickedAt: new Date() } }),
      StoreDailyStat.updateOne({ store: product.store, day }, { $inc: { affiliateClicks: 1 } }, { upsert: true }),
      AffiliateClick.create({ product: product._id, store: product.store, visitor: visitorKey || '', day }),
    ]);
  } catch (err) {
    log.warn('analytics.track_click_failed', { productId: String(product._id), message: err?.message });
  }
}

// ---------- reports ----------

function summarizeOrders(orders, daysMap) {
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, { orders: 0, gross: 0, fees: 0, net: 0 }]));
  const totals = { orders: 0, gross: 0, fees: 0, net: 0 };
  orders.forEach((o) => {
    const gross = grossOf(o);
    const src = bySource[o.itemType];
    if (src) {
      src.orders += 1;
      src.gross += gross;
      src.fees += o.feeAmount || 0;
      src.net += o.creatorEarning || 0;
    }
    totals.orders += 1;
    totals.gross += gross;
    totals.fees += o.feeAmount || 0;
    totals.net += o.creatorEarning || 0;
    if (daysMap) {
      const day = daysMap.get(istDay(o.paidAt));
      if (day) {
        day.orders += 1;
        day.gross += gross;
        day.net += o.creatorEarning || 0;
      }
    }
  });
  return { totals, bySource };
}

/** Everything the creator's Analytics screen shows, for the last `days` days. */
async function creatorAnalytics(store, days) {
  const from = rangeStart(days);
  const fromDay = istDay(from);
  const daysMap = emptyDays(from, days);

  const [orders, dailyStats, visits, lives, calls, affiliateTop, affiliateEarnings, affiliateClicks] = await Promise.all([
    StoreOrder.find({ seller: store.user, status: ORDER_STATUS.PAID, paidAt: { $gte: from } }).select(
      'itemType itemId itemTitle amount settledAmount feeAmount creatorEarning paidAt buyer'
    ),
    StoreDailyStat.find({ store: store._id, day: { $gte: fromDay } }),
    StoreVisit.find({ store: store._id, day: { $gte: fromDay } }).select('day visitor'),
    LiveStream.find({ host: store.user, startedAt: { $gte: from } }).select('title stats startedAt'),
    CallSession.find({ host: store.user, status: CALL_STATUS.COMPLETED, endedAt: { $gte: from } }).select('billedMinutes billedAmount creatorEarning'),
    AffiliateProduct.find({ store: store._id, clicks: { $gt: 0 } }).sort({ clicks: -1 }).limit(5).select('title imageUrl merchant clicks'),
    AffiliateEarning.find({ store: store._id, earnedAt: { $gte: from } }).select('amount status orders'),
    AffiliateClick.countDocuments({ store: store._id, day: { $gte: fromDay } }),
  ]);

  const { totals, bySource } = summarizeOrders(orders, daysMap);

  dailyStats.forEach((s) => {
    const day = daysMap.get(s.day);
    if (day) {
      day.views += s.views || 0;
      day.affiliateClicks += s.affiliateClicks || 0;
    }
  });
  const uniqueVisitors = new Set();
  visits.forEach((v) => {
    uniqueVisitors.add(v.visitor);
    const day = daysMap.get(v.day);
    if (day) day.visitors += 1;
  });
  const views = dailyStats.reduce((sum, s) => sum + (s.views || 0), 0);
  const productViews = dailyStats.reduce((sum, s) => sum + (s.productViews || 0), 0);

  // Top items by revenue in the range.
  const itemTotals = new Map();
  orders.forEach((o) => {
    if (o.itemType === ORDER_ITEM.FANBOX || o.itemType === ORDER_ITEM.CALL) return;
    const key = String(o.itemId);
    const row = itemTotals.get(key) || { itemId: o.itemId, itemType: o.itemType, title: o.itemTitle, orders: 0, gross: 0 };
    row.orders += 1;
    row.gross += grossOf(o);
    itemTotals.set(key, row);
  });
  const topItems = [...itemTotals.values()].sort((a, b) => b.gross - a.gross).slice(0, 5);

  const fanboxOrders = orders.filter((o) => o.itemType === ORDER_ITEM.FANBOX);
  const affiliate = { clicks: affiliateClicks, pending: 0, confirmed: 0, reversed: 0, orders: 0, topProducts: affiliateTop };
  affiliateEarnings.forEach((e) => {
    affiliate[e.status] += e.amount;
    if (e.status !== AFFILIATE_EARNING_STATUS.REVERSED) affiliate.orders += e.orders || 0;
  });

  const buyers = new Set(orders.map((o) => String(o.buyer)));
  return {
    range: { days, from, to: new Date() },
    totals: {
      ...totals,
      views,
      productViews,
      uniqueVisitors: uniqueVisitors.size,
      customers: buyers.size,
      // Share of unique visitors who bought something.
      conversionRate: uniqueVisitors.size ? Math.round((buyers.size / uniqueVisitors.size) * 1000) / 10 : 0,
      affiliateConfirmed: affiliate.confirmed,
    },
    bySource,
    daily: [...daysMap.values()],
    topItems,
    lives: {
      count: lives.length,
      totalJoins: lives.reduce((s, l) => s + (l.stats?.totalJoins || 0), 0),
      peakViewers: lives.reduce((m, l) => Math.max(m, l.stats?.peakViewers || 0), 0),
      ticketsSold: lives.reduce((s, l) => s + (l.stats?.ticketsSold || 0), 0),
    },
    calls: {
      completed: calls.length,
      minutes: calls.reduce((s, c) => s + (c.billedMinutes || 0), 0),
      billed: calls.reduce((s, c) => s + (c.billedAmount || 0), 0),
      earnings: calls.reduce((s, c) => s + (c.creatorEarning || 0), 0),
    },
    fanbox: {
      count: fanboxOrders.length,
      gross: fanboxOrders.reduce((s, o) => s + o.amount, 0),
      supporters: new Set(fanboxOrders.map((o) => String(o.buyer))).size,
    },
    affiliate,
  };
}

/** Platform-wide numbers for the admin panel. */
async function platformAnalytics(days) {
  const from = rangeStart(days);
  const daysMap = emptyDays(from, days);
  const [orders, clicks, calls] = await Promise.all([
    StoreOrder.find({ status: ORDER_STATUS.PAID, paidAt: { $gte: from } }).select(
      'itemType amount settledAmount feeAmount creatorEarning paidAt store seller'
    ),
    AffiliateClick.countDocuments({ day: { $gte: istDay(from) } }),
    CallSession.find({ status: CALL_STATUS.COMPLETED, endedAt: { $gte: from } }).select('billedMinutes'),
  ]);
  const { totals, bySource } = summarizeOrders(orders, daysMap);

  const byStore = new Map();
  orders.forEach((o) => {
    if (!o.store) return;
    const key = String(o.store);
    const row = byStore.get(key) || { store: o.store, orders: 0, gross: 0, fees: 0 };
    row.orders += 1;
    row.gross += grossOf(o);
    row.fees += o.feeAmount || 0;
    byStore.set(key, row);
  });
  const top = [...byStore.values()].sort((a, b) => b.gross - a.gross).slice(0, 10);
  const names = await Store.find({ _id: { $in: top.map((t) => t.store) } }).select('name slug logoUrl');
  const byId = new Map(names.map((n) => [String(n._id), n]));
  const topStores = top.map((t) => {
    const info = byId.get(String(t.store));
    return { ...t, name: info?.name || 'Deleted store', slug: info?.slug || '', logoUrl: info?.logoUrl || '' };
  });

  return {
    range: { days, from, to: new Date() },
    // `fees` is Fanitt's store revenue.
    totals: { ...totals, sellers: new Set(orders.map((o) => String(o.seller))).size, affiliateClicks: clicks, callMinutes: calls.reduce((s, c) => s + (c.billedMinutes || 0), 0) },
    bySource,
    daily: [...daysMap.values()].map(({ date, gross, net, orders: n }) => ({ date, gross, net, orders: n })),
    topStores,
  };
}

/** Everyone who bought from this creator, most valuable first. */
async function customers(sellerId, { page, limit }) {
  const orders = await StoreOrder.find({ seller: sellerId, status: ORDER_STATUS.PAID })
    .sort({ paidAt: -1 })
    .limit(5000)
    .select('buyer itemType amount settledAmount paidAt')
    .populate('buyer', 'name avatarUrl');
  const byBuyer = new Map();
  orders.forEach((o) => {
    if (!o.buyer) return;
    const key = String(o.buyer._id);
    const row = byBuyer.get(key) || { user: o.buyer, orders: 0, spent: 0, lastPurchaseAt: o.paidAt, types: new Set() };
    row.orders += 1;
    row.spent += grossOf(o);
    row.types.add(o.itemType);
    byBuyer.set(key, row);
  });
  const all = [...byBuyer.values()].sort((a, b) => b.spent - a.spent).map((r) => ({ ...r, types: [...r.types] }));
  const start = (page - 1) * limit;
  return { customers: all.slice(start, start + limit), total: all.length, page, pages: Math.ceil(all.length / limit) };
}

module.exports = { istDay, trackStoreView, trackProductView, trackAffiliateClick, creatorAnalytics, platformAnalytics, customers };