const axios = require('axios');
const dns = require('dns').promises;
const net = require('net');
const ApiError = require('../../utils/apiError');
const { LIMITS } = require('../constants');
const log = require('../utils/logger');

// Reads a product page (Amazon, Nykaa…) and pulls out its title, image,
// price and shop name from the page's meta tags, to pre-fill the
// affiliate product form. Guarded so it can't be used to reach our own
// servers or private networks.

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw ApiError.badRequest('Enter a full link starting with https://');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw ApiError.badRequest('Only http(s) links are allowed');
  if (url.username || url.password) throw ApiError.badRequest('Links with a username or password are not allowed');
  const records = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!records.length) throw ApiError.badRequest("We couldn't reach that website");
  if (records.some((r) => isPrivateIp(r.address))) throw ApiError.badRequest('That link is not allowed');
  return url;
}

function decode(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function meta(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${escaped}["'][^>]*content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["']${escaped}["']`, 'i'),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) return decode(m[1]);
    }
  }
  return '';
}

/** Rupees text ("1,299.00") → paise, or null. */
function toPaise(text) {
  const n = Number(String(text).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

async function preview(rawUrl) {
  const url = await assertPublicUrl(rawUrl);
  let html = '';
  let finalUrl = url.toString();
  try {
    const res = await axios.get(url.toString(), {
      timeout: LIMITS.PREVIEW_TIMEOUT_MS,
      maxContentLength: LIMITS.PREVIEW_MAX_BYTES,
      maxRedirects: 3,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FanittBot/1.0; +https://fanitt.com)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
      // Re-check every redirect hop so a public link can't bounce to a private address.
      beforeRedirect: (options) => {
        if (options.hostname && net.isIP(options.hostname) && isPrivateIp(options.hostname)) {
          throw new Error('Redirect to a private address blocked');
        }
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    html = typeof res.data === 'string' ? res.data : '';
    finalUrl = res.request?.res?.responseUrl || finalUrl;
  } catch (err) {
    log.warn('affiliate.preview_fetch_failed', { host: url.hostname, message: err?.message });
    // Not an error for the creator — they just fill the form by hand.
    return { url: url.toString(), title: '', imageUrl: '', price: null, merchant: url.hostname.replace(/^www\./, ''), found: false };
  }

  const titleTag = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
  const title = meta(html, ['og:title', 'twitter:title']) || decode(titleTag?.[1] || '');
  let imageUrl = meta(html, ['og:image:secure_url', 'og:image', 'twitter:image']);
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    try {
      imageUrl = new URL(imageUrl, finalUrl).toString();
    } catch {
      imageUrl = '';
    }
  }
  const price = toPaise(meta(html, ['product:price:amount', 'og:price:amount', 'price']));
  const merchant = meta(html, ['og:site_name']) || url.hostname.replace(/^www\./, '');

  return {
    url: url.toString(),
    title: title.slice(0, 150),
    description: meta(html, ['og:description', 'description']).slice(0, 1000),
    imageUrl: imageUrl.startsWith('https://') ? imageUrl : '',
    price,
    merchant: merchant.slice(0, 60),
    found: Boolean(title || imageUrl),
  };
}

module.exports = { preview, assertPublicUrl, isPrivateIp };
