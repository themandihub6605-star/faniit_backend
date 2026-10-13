const mongoose = require('mongoose');

// App-wide feature switches the admin can flip without a deploy.
//
//   GET  /api/features                  public — what the app and website should show
//   GET  /api/admin/monitor/features    admin  — same, plus who changed it last
//   PATCH /api/admin/monitor/features   admin  — { storeEnabled: true|false }
//
// `storeEnabled` = the Fanitt Store's PHYSICAL PRODUCTS (merch shop).
// Off: browsing physical products, the cart and starting a new checkout
// answer 503 (errorCode SHOP_DISABLED), and /store/config + /store/shop/config
// report the shop as off. Everything else in the store keeps working —
// creator stores, digital products, lives, calls, FanBox, payment
// verification, existing orders (buyers and sellers) and the admin panel.

const featureSchema = new mongoose.Schema(
  {
    _singleton: { type: String, default: 'app', unique: true },
    storeEnabled: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'appfeatures' }
);
const AppFeature = mongoose.models.AppFeature || mongoose.model('AppFeature', featureSchema);

// Small in-memory cache so the store gate doesn't hit the database on every request.
const TTL_MS = 10_000;
let cache = null;
let cachedAt = 0;

async function getFeatures({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  try {
    const doc = await AppFeature.findOne({ _singleton: 'app' }).lean();
    cache = { storeEnabled: doc ? doc.storeEnabled !== false : true, updatedAt: doc?.updatedAt || null, updatedBy: doc?.updatedBy || null };
  } catch {
    // Database hiccup: keep the last known value (default on).
    cache = cache || { storeEnabled: true, updatedAt: null, updatedBy: null };
  }
  cachedAt = Date.now();
  return cache;
}

async function setFeatures({ storeEnabled }, userId) {
  const update = {};
  if (typeof storeEnabled === 'boolean') update.storeEnabled = storeEnabled;
  update.updatedBy = userId || null;
  await AppFeature.updateOne({ _singleton: 'app' }, { $set: update, $setOnInsert: { _singleton: 'app' } }, { upsert: true });
  return getFeatures({ fresh: true });
}

const publicView = (f) => ({ store: { enabled: f.storeEnabled } });

// Physical-products shop paths that stop while the shop is off.
const SHOP_BLOCKED = [
  /^\/store\/shop\/products(\/|$)/, // browse & product pages
  /^\/store\/shop\/cart(\/|$)/,
  /^\/store\/shop\/checkout(\/preview)?$/, // a NEW checkout (verify of a started one stays open)
  /^\/store\/shop\/me\/products$/, // sellers adding new products (POST)
];

/**
 * Router-level middleware (mounted with the monitor tracker, before all
 * routes). Answers GET /features and pauses the physical-products shop when it's off.
 * `req.path` here is relative to /api.
 */
async function featureGate(req, res, next) {
  try {
    if (req.method === 'GET' && req.path === '/features') {
      const f = await getFeatures();
      res.set('Cache-Control', 'no-store');
      return res.status(200).json({ success: true, message: 'Features fetched', data: publicView(f) });
    }
    if (req.path === '/store' || req.path.startsWith('/store/')) {
      // Store + shop config stay readable, but say "shop off" while it is.
      if (req.method === 'GET' && (req.path === '/store/config' || req.path === '/store/shop/config')) {
        const f = await getFeatures();
        res.set('Cache-Control', 'no-store');
        if (!f.storeEnabled) {
          // Remember which config this is — Express rewrites req.path inside the /store router.
          const isStoreConfig = req.path === '/store/config';
          const json = res.json.bind(res);
          res.json = (body) => {
            if (body && body.data && typeof body.data === 'object') {
              if (isStoreConfig) {
                body.data = { ...body.data, shopVisible: false, shop: body.data.shop ? { ...body.data.shop, enabled: false } : body.data.shop };
              } else {
                body.data = { ...body.data, enabled: false };
              }
            }
            return json(body);
          };
        }
        return next();
      }
      const blocked = SHOP_BLOCKED.some((re) => re.test(req.path)) && !(req.path === '/store/shop/me/products' && req.method === 'GET');
      if (blocked) {
        const f = await getFeatures();
        if (!f.storeEnabled) {
          return res.status(503).json({ success: false, message: 'Fanitt Store products are paused right now. Please check back later.', errors: [], errorCode: 'SHOP_DISABLED' });
        }
      }
    }
  } catch {
    // Never block the API because of the gate itself.
  }
  return next();
}

module.exports = { featureGate, getFeatures, setFeatures, publicView, AppFeature };

// ---- Admin handlers (mounted in monitor.routes.js, admins only) ----
async function getFeaturesAdmin(req, res, next) {
  try {
    const f = await getFeatures({ fresh: true });
    let by = null;
    if (f.updatedBy) {
      try {
        by = await mongoose.model('User').findById(f.updatedBy).select('name email').lean();
      } catch {
        by = null;
      }
    }
    return res.status(200).json({ success: true, message: 'Features fetched', data: { storeEnabled: f.storeEnabled, updatedAt: f.updatedAt, updatedBy: by } });
  } catch (err) {
    return next(err);
  }
}

async function updateFeaturesAdmin(req, res, next) {
  try {
    const { storeEnabled } = req.body || {};
    if (typeof storeEnabled !== 'boolean') return res.status(400).json({ success: false, message: 'storeEnabled must be true or false', errors: [], errorCode: null });
    const f = await setFeatures({ storeEnabled }, req.user?._id);
    return res.status(200).json({ success: true, message: storeEnabled ? 'Fanitt Store turned on' : 'Fanitt Store turned off', data: { storeEnabled: f.storeEnabled, updatedAt: f.updatedAt } });
  } catch (err) {
    return next(err);
  }
}

module.exports.getFeaturesAdmin = getFeaturesAdmin;
module.exports.updateFeaturesAdmin = updateFeaturesAdmin;