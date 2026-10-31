// File: src/controllers/homeBanner.controller.js
const mongoose = require('mongoose');
const HomeBanner = require('../models/HomeBanner.model');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

const { LINK_TYPES, SCREENS, PLATFORMS, AUDIENCES, MAX_HISTORY } = HomeBanner;
const MAX_ACTIVE = 10;

function assertId(id) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound('Banner not found');
}

function publicShape(b) {
  return {
    _id: b._id,
    imageUrl: b.imageUrl,
    title: b.title,
    subtitle: b.subtitle,
    ctaLabel: b.ctaLabel,
    linkType: b.linkType,
    linkValue: b.linkValue,
  };
}

/** Body fields → clean banner fields (multipart sends everything as text). */
function readFields(body, { partial }) {
  const out = {};
  const str = (k, max) => {
    if (body[k] !== undefined) out[k] = String(body[k] ?? '').trim().slice(0, max);
  };
  str('title', 70);
  str('subtitle', 120);
  str('ctaLabel', 24);
  str('linkValue', 500);

  if (body.linkType !== undefined) {
    if (!LINK_TYPES.includes(body.linkType)) throw ApiError.badRequest('Unknown link type');
    out.linkType = body.linkType;
  }
  if (body.platform !== undefined) {
    if (!PLATFORMS.includes(body.platform)) throw ApiError.badRequest('Unknown platform');
    out.platform = body.platform;
  }
  if (body.audience !== undefined) {
    let list = body.audience;
    if (typeof list === 'string') {
      try {
        list = JSON.parse(list);
      } catch {
        list = list.split(',');
      }
    }
    out.audience = [...new Set((Array.isArray(list) ? list : []).map((a) => String(a).trim()).filter((a) => AUDIENCES.includes(a)))];
  }
  if (body.isActive !== undefined) out.isActive = body.isActive === true || body.isActive === 'true';
  if (body.takeover !== undefined) out.takeover = body.takeover === true || body.takeover === 'true';
  for (const k of ['startsAt', 'endsAt']) {
    if (body[k] !== undefined) {
      if (!body[k]) out[k] = null;
      else {
        const d = new Date(body[k]);
        if (Number.isNaN(d.getTime())) throw ApiError.badRequest(`Invalid ${k}`);
        out[k] = d;
      }
    }
  }

  // Link must make sense.
  const type = out.linkType;
  if (type && type !== 'none' && !partial && !out.linkValue) throw ApiError.badRequest('Add where the banner should open');
  if (type === 'screen' && out.linkValue && !SCREENS.includes(out.linkValue)) throw ApiError.badRequest('Unknown screen');
  if (type === 'url' && out.linkValue && !/^https?:\/\//i.test(out.linkValue)) throw ApiError.badRequest('Link must start with http:// or https://');
  if (type === 'none') out.linkValue = '';
  return out;
}

/** Final checks on the whole banner (after create / update fields are applied). */
function validate(b) {
  if (b.linkType !== 'none' && !b.linkValue) throw ApiError.badRequest('Add where the banner should open');
  if (b.startsAt && b.endsAt && b.endsAt <= b.startsAt) throw ApiError.badRequest('End must be after start');
  // A festival banner must end, so the regular ones come back on their own.
  if (b.takeover && (!b.startsAt || !b.endsAt)) throw ApiError.badRequest('A festival banner needs a start and an end date');
}

/** Keeps the current picture in the history before a new one replaces it. */
function rememberImage(banner, oldUrl) {
  if (!oldUrl) return;
  const rest = (banner.imageHistory || []).filter((h) => h.url !== oldUrl);
  banner.imageHistory = [{ url: oldUrl, replacedAt: new Date() }, ...rest].slice(0, MAX_HISTORY);
}

// ---------- Public ----------

/** GET /api/home/banners?platform=app&role=creator — live banners, in order. */
const listPublic = catchAsync(async (req, res) => {
  const platform = PLATFORMS.includes(req.query.platform) ? req.query.platform : 'app';
  const role = AUDIENCES.includes(req.query.role) ? req.query.role : null;
  const now = new Date();

  const filter = {
    isActive: true,
    archivedAt: null,
    platform: { $in: ['all', platform] },
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
      role ? { $or: [{ audience: { $size: 0 } }, { audience: role }] } : { audience: { $size: 0 } },
    ],
  };

  let banners = await HomeBanner.find(filter).sort({ order: 1, createdAt: -1 }).limit(50);
  // Festival / special banners live for this person → only those, until they end.
  if (banners.some((b) => b.takeover)) banners = banners.filter((b) => b.takeover);
  banners = banners.slice(0, MAX_ACTIVE);

  if (banners.length) {
    HomeBanner.updateMany({ _id: { $in: banners.map((b) => b._id) } }, { $inc: { views: 1 } }).catch(() => {});
  }
  return new ApiResponse(200, { banners: banners.map(publicShape) }, 'Banners').send(res);
});

/** POST /api/home/banners/:id/click — counts a tap. */
const trackClick = catchAsync(async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) {
    await HomeBanner.updateOne({ _id: req.params.id }, { $inc: { clicks: 1 } });
  }
  return new ApiResponse(200, null, 'OK').send(res);
});

// ---------- Admin ----------

/** GET /api/home/admin/banners — every banner, archived ones included. */
const adminList = catchAsync(async (req, res) => {
  const banners = await HomeBanner.find().sort({ order: 1, createdAt: -1 });
  return new ApiResponse(200, { banners, options: { linkTypes: LINK_TYPES, screens: SCREENS, platforms: PLATFORMS, audiences: AUDIENCES } }, 'Banners').send(res);
});

/** POST /api/home/admin/banners (multipart: image + fields) */
const adminCreate = catchAsync(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Upload a banner image');
  const fields = readFields(req.body, { partial: false });
  const last = await HomeBanner.findOne().sort({ order: -1 }).select('order');
  const banner = new HomeBanner({
    ...fields,
    imageUrl: req.file.path,
    order: (last?.order ?? -1) + 1,
    createdBy: req.user._id,
  });
  validate(banner);
  await banner.save();
  return new ApiResponse(201, banner, 'Banner added').send(res);
});

/** PATCH /api/home/admin/banners/:id (multipart; image optional) */
const adminUpdate = catchAsync(async (req, res) => {
  assertId(req.params.id);
  const banner = await HomeBanner.findById(req.params.id);
  if (!banner) throw ApiError.notFound('Banner not found');

  const fields = readFields(req.body, { partial: true });
  Object.assign(banner, fields);
  if (req.file) {
    rememberImage(banner, banner.imageUrl);
    banner.imageUrl = req.file.path;
  }
  validate(banner);
  await banner.save();
  return new ApiResponse(200, banner, 'Banner saved').send(res);
});

/** POST /api/home/admin/banners/:id/image { url } — puts an earlier picture back. */
const adminUseOldImage = catchAsync(async (req, res) => {
  assertId(req.params.id);
  const banner = await HomeBanner.findById(req.params.id);
  if (!banner) throw ApiError.notFound('Banner not found');
  const url = String(req.body.url || '');
  if (!(banner.imageHistory || []).some((h) => h.url === url)) throw ApiError.badRequest('That picture is not in this banner’s history');
  const current = banner.imageUrl;
  banner.imageHistory = banner.imageHistory.filter((h) => h.url !== url);
  rememberImage(banner, current);
  banner.imageUrl = url;
  await banner.save();
  return new ApiResponse(200, banner, 'Picture restored').send(res);
});

/**
 * DELETE /api/home/admin/banners/:id
 *   first time → archives it (hidden, can be restored)
 *   ?permanent=1 on an archived banner → removed for good
 */
const adminDelete = catchAsync(async (req, res) => {
  assertId(req.params.id);
  const banner = await HomeBanner.findById(req.params.id);
  if (!banner) throw ApiError.notFound('Banner not found');
  const permanent = req.query.permanent === '1' || req.query.permanent === 'true';
  if (permanent) {
    if (!banner.archivedAt) throw ApiError.badRequest('Archive the banner first');
    await banner.deleteOne();
    return new ApiResponse(200, null, 'Banner deleted for good').send(res);
  }
  banner.archivedAt = new Date();
  banner.isActive = false;
  await banner.save();
  return new ApiResponse(200, banner, 'Banner archived').send(res);
});

/** POST /api/home/admin/banners/:id/restore — brings an archived banner back (switched off). */
const adminRestore = catchAsync(async (req, res) => {
  assertId(req.params.id);
  const banner = await HomeBanner.findById(req.params.id);
  if (!banner) throw ApiError.notFound('Banner not found');
  banner.archivedAt = null;
  await banner.save();
  return new ApiResponse(200, banner, 'Banner restored').send(res);
});

/** PUT /api/home/admin/banners/order { ids: [...] } — array order = slide order. */
const adminReorder = catchAsync(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((id) => mongoose.isValidObjectId(id)) : [];
  if (!ids.length) throw ApiError.badRequest('Nothing to reorder');
  await HomeBanner.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { order: i } } } })));
  const banners = await HomeBanner.find().sort({ order: 1, createdAt: -1 });
  return new ApiResponse(200, { banners }, 'Order saved').send(res);
});

module.exports = { listPublic, trackClick, adminList, adminCreate, adminUpdate, adminUseOldImage, adminDelete, adminRestore, adminReorder };