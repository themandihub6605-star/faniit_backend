const { StoreSettings } = require('../models');
const { TOOL_KEYS } = require('../constants');

// Store settings are read on almost every request, so they're cached for
// a short time. Any admin update calls invalidate().

const CACHE_MS = 30 * 1000;
let cached = null;
let cachedAt = 0;

/** Makes sure every tool card exists (new tools added in code appear
 * automatically) without touching the admin's edits. */
function withAllToolCards(settings) {
  const defaults = StoreSettings.DEFAULT_TOOL_CARDS;
  const present = new Set((settings.toolCards || []).map((c) => c.key));
  let changed = false;
  TOOL_KEYS.forEach((key, index) => {
    if (!present.has(key)) {
      const def = defaults.find((d) => d.key === key);
      settings.toolCards.push({ ...def, order: index });
      changed = true;
    }
  });
  return changed;
}

/**
 * `fresh: true` returns a separate copy straight from the database — use
 * it whenever you're going to change and save settings, so a failed save
 * can never leave half-edited values in the shared cache.
 */
async function getSettings({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < CACHE_MS) return cached;
  let settings = await StoreSettings.findOne({ _singleton: 'store' });
  if (!settings) {
    try {
      settings = await StoreSettings.create({ _singleton: 'store' });
    } catch (err) {
      // Two requests created it at the same moment — read the winner.
      if (err?.code !== 11000) throw err;
      settings = await StoreSettings.findOne({ _singleton: 'store' });
    }
  }
  if (withAllToolCards(settings)) await settings.save();
  if (!fresh) {
    cached = settings;
    cachedAt = Date.now();
  }
  return settings;
}

function invalidate() {
  cached = null;
  cachedAt = 0;
}

/** What the apps and website need (no admin-only fields). */
function publicConfig(settings) {
  return {
    storeFeePercent: settings.storeFeePercent,
    fanboxFeePercent: settings.fanboxFeePercent,
    requireSubscription: Boolean(settings.requireSubscription),
    termsVersion: settings.termsVersion,
    toolCards: [...settings.toolCards].filter((c) => c.enabled).sort((a, b) => a.order - b.order),
    webBanner: settings.webBanner?.enabled ? settings.webBanner : null,
    shop: {
      enabled: settings.shopEnabled !== false,
      feePercent: settings.shopFeePercent ?? settings.storeFeePercent,
      codEnabled: settings.shopCodEnabled !== false,
      onlineEnabled: settings.shopOnlineEnabled !== false,
      codMaxAmount: settings.shopCodMaxAmount || 0,
    },
  };
}

module.exports = { getSettings, invalidate, publicConfig };