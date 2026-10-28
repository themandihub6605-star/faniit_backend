// File: src/FanittStore/services/affiliateLinks.service.js
const axios = require('axios');
const { AffiliateProduct } = require('../models');
const { AFFILIATE_STATUS } = require('../constants');
const { safeNotify } = require('./notify.service');
const log = require('../utils/logger');

// Checks creators' affiliate links about once a week. Shops like Amazon
// often block bots (403/503), so only a clear "page is gone" (404/410) or
// an unreachable site counts — and only after two checks in a row.

const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const PER_RUN = 5;
const MIN_GAP_MS = 10 * 60 * 1000; // run at most every 10 minutes
let lastRun = 0;

async function isGone(url) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 5,
      maxContentLength: 512 * 1024,
      responseType: 'stream',
      validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FanittBot/1.0; +https://fanitt.com)', Accept: 'text/html' },
    });
    res.data?.destroy?.();
    return res.status === 404 || res.status === 410;
  } catch (err) {
    // DNS failure / connection refused = the site is gone. Timeouts don't count.
    return ['ENOTFOUND', 'ECONNREFUSED'].includes(err?.code);
  }
}

async function checkSome() {
  if (Date.now() - lastRun < MIN_GAP_MS) return;
  lastRun = Date.now();
  const due = await AffiliateProduct.find({
    status: { $ne: AFFILIATE_STATUS.REMOVED },
    $or: [{ linkCheckedAt: null }, { linkCheckedAt: { $lt: new Date(Date.now() - RECHECK_MS) } }],
  })
    .sort({ linkCheckedAt: 1 })
    .limit(PER_RUN);

  for (const p of due) {
    // eslint-disable-next-line no-await-in-loop
    const gone = await isGone(p.url);
    const failures = gone ? (p.linkFailures || 0) + 1 : 0;
    const broken = failures >= 2;
    const becameBroken = broken && !p.linkBroken;
    // eslint-disable-next-line no-await-in-loop
    await AffiliateProduct.updateOne(
      { _id: p._id },
      // A first failure is checked again tomorrow instead of next week.
      { $set: { linkFailures: failures, linkBroken: broken, linkCheckedAt: failures === 1 ? new Date(Date.now() - RECHECK_MS + 24 * 60 * 60 * 1000) : new Date() } }
    );
    if (becameBroken) {
      // eslint-disable-next-line no-await-in-loop
      await safeNotify({
        userId: p.owner,
        type: 'store_order',
        title: 'An affiliate link stopped working',
        message: `"${p.title}" — the shop page seems to be gone. Update the link or hide the product.`,
        relatedModel: 'Store',
        relatedId: p.store,
      });
      log.info('affiliate.link_broken', { productId: String(p._id) });
    }
  }
}

module.exports = { checkSome };