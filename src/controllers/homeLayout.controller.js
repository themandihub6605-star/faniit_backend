const mongoose = require('mongoose');
const HomeLayout = require('../models/HomeLayout.model');
const { CreatorProfile, BrandProfile, Campaign, Session, Community, User } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

const { SECTION_KEYS, DEFAULT_SECTIONS } = HomeLayout;
// Sections whose items come automatically (nothing to pin).
const NO_PINS = new Set(['live']);

const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Store models are registered by src/FanittStore when it loads.
const storeModels = () => ({ DigitalProduct: mongoose.models.DigitalProduct, Store: mongoose.models.Store });

/**
 * Finds items of one type for the admin picker — by search text or by ids.
 * Every item comes back as { id, title, subtitle, imageUrl }.
 */
async function findItems(type, { q, ids }) {
  const byText = (fields) => {
    if (!q) return {};
    const pattern = new RegExp(escape(q), 'i');
    return { $or: fields.map((f) => ({ [f]: pattern })) };
  };
  const byIds = ids ? { _id: { $in: ids.filter((id) => mongoose.isValidObjectId(id)) } } : {};
  const limit = ids ? 50 : 20;

  switch (type) {
    case 'creators': {
      let match = { ...byIds };
      if (q) {
        const users = await User.find({ role: 'creator', ...byText(['name', 'email']) }).select('_id').limit(40);
        match = { $or: [{ user: { $in: users.map((u) => u._id) } }, { slug: new RegExp(escape(q), 'i') }] };
      }
      const rows = await CreatorProfile.find(match).populate('user', 'name avatarUrl').sort({ followerCount: -1 }).limit(limit);
      return rows.map((c) => ({ id: String(c._id), title: c.user?.name || c.slug, subtitle: `${c.followerCount || 0} followers`, imageUrl: c.user?.avatarUrl || '' }));
    }
    case 'brands': {
      const rows = await BrandProfile.find({ ...byIds, ...byText(['companyName']) }).populate('user', 'avatarUrl').limit(limit);
      return rows.map((b) => ({ id: String(b._id), title: b.companyName, subtitle: b.industry || 'Brand', imageUrl: b.logoUrl || b.user?.avatarUrl || '' }));
    }
    case 'campaigns': {
      const rows = await Campaign.find({ ...byIds, ...byText(['title']) }).populate('brand', 'companyName logoUrl').sort({ createdAt: -1 }).limit(limit);
      return rows.map((c) => ({ id: String(c._id), title: c.title, subtitle: `${c.brand?.companyName || 'Brand'} · ${c.status}`, imageUrl: c.campaignImageUrl || c.brand?.logoUrl || '' }));
    }
    case 'meets': {
      const rows = await Session.find({ isCancelled: { $ne: true }, ...byIds, ...byText(['title']) }).sort({ scheduledAt: -1 }).limit(limit);
      return rows.map((s) => ({
        id: String(s._id),
        title: s.title,
        subtitle: `${new Date(s.scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}${s.isCompleted ? ' · ended' : ''}`,
        imageUrl: s.coverImageUrl || '',
      }));
    }
    case 'communities': {
      const rows = await Community.find({ ...byIds, ...byText(['name']) }).sort({ memberCount: -1 }).limit(limit);
      return rows.map((c) => ({ id: String(c._id), title: c.name, subtitle: `${c.memberCount || 0} members`, imageUrl: c.iconUrl || '' }));
    }
    case 'products': {
      const { DigitalProduct } = storeModels();
      if (!DigitalProduct) return [];
      const rows = await DigitalProduct.find({ status: 'published', ...byIds, ...byText(['title']) }).sort({ salesCount: -1 }).limit(limit);
      return rows.map((p) => ({ id: String(p._id), title: p.title, subtitle: p.price ? `₹${(p.price / 100).toLocaleString('en-IN')}` : 'Free', imageUrl: p.coverUrl || '' }));
    }
    case 'stores': {
      const { Store } = storeModels();
      if (!Store) return [];
      const rows = await Store.find({ status: 'active', ...byIds, ...byText(['name', 'slug']) }).limit(limit);
      return rows.map((s) => ({ id: String(s._id), title: s.name, subtitle: `/${s.slug}`, imageUrl: s.logoUrl || '' }));
    }
    default:
      return [];
  }
}

/** GET /api/home/layout — what the app home shows, in order (public). */
const getPublicLayout = catchAsync(async (req, res) => {
  const layout = await HomeLayout.get();
  const sections = layout.sections
    .filter((s) => s.enabled)
    .map((s) => ({ key: s.key, title: s.title, subtitle: s.subtitle, pinned: NO_PINS.has(s.key) ? [] : s.pinned }));
  return new ApiResponse(200, { sections }, 'Home layout').send(res);
});

/** GET /api/admin/home-layout — every section, with pinned items filled in. */
const getAdminLayout = catchAsync(async (req, res) => {
  const layout = await HomeLayout.get();
  const sections = await Promise.all(
    layout.sections.map(async (s) => {
      const found = s.pinned.length ? await findItems(s.key, { ids: s.pinned }) : [];
      const byId = new Map(found.map((i) => [i.id, i]));
      return {
        key: s.key,
        title: s.title,
        subtitle: s.subtitle,
        enabled: s.enabled,
        canPin: !NO_PINS.has(s.key),
        // Keep the saved order; drop items that no longer exist.
        pinned: s.pinned.map((id) => byId.get(id)).filter(Boolean),
      };
    })
  );
  return new ApiResponse(200, { sections, defaults: DEFAULT_SECTIONS }, 'Home layout').send(res);
});

/** PUT /api/admin/home-layout { sections: [{ key, title, subtitle, enabled, pinned: [ids] }] } — array order = screen order. */
const saveLayout = catchAsync(async (req, res) => {
  const input = Array.isArray(req.body.sections) ? req.body.sections : null;
  if (!input) throw ApiError.badRequest('Send the sections');
  const seen = new Set();
  const sections = [];
  for (const s of input) {
    if (!SECTION_KEYS.includes(s.key) || seen.has(s.key)) throw ApiError.badRequest(`Unknown or repeated section: ${s.key}`);
    seen.add(s.key);
    const def = DEFAULT_SECTIONS.find((d) => d.key === s.key);
    sections.push({
      key: s.key,
      title: String(s.title || def.title).trim().slice(0, 60),
      subtitle: String(s.subtitle ?? def.subtitle).trim().slice(0, 120),
      enabled: s.enabled !== false,
      pinned: NO_PINS.has(s.key)
        ? []
        : [...new Set((Array.isArray(s.pinned) ? s.pinned : []).map(String).filter((id) => mongoose.isValidObjectId(id)))].slice(0, 20),
    });
  }
  // Sections not sent keep going at the end (hidden), so nothing is lost.
  for (const def of DEFAULT_SECTIONS) {
    if (!seen.has(def.key)) sections.push({ ...def, enabled: false, pinned: [] });
  }
  const layout = await HomeLayout.get();
  layout.sections = sections;
  await layout.save();
  return new ApiResponse(200, null, 'Home screen saved').send(res);
});

/** GET /api/admin/home-layout/search?type=creators&q= — items to pin. */
const searchItems = catchAsync(async (req, res) => {
  const type = String(req.query.type || '');
  if (!SECTION_KEYS.includes(type) || NO_PINS.has(type)) throw ApiError.badRequest('Pick a section');
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return new ApiResponse(200, [], 'Type at least 2 letters').send(res);
  return new ApiResponse(200, await findItems(type, { q }), 'Results').send(res);
});

module.exports = { getPublicLayout, getAdminLayout, saveLayout, searchItems };