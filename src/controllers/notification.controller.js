const { Notification, CreatorProfile, BrandProfile } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

const getMyNotifications = catchAsync(async (req, res) => {
  const { unreadOnly } = req.query;
  const filter = { user: req.user._id, ...(unreadOnly === 'true' && { isRead: false }) };
  // ?types=like,follow — only those kinds (the app's Activity screen).
  const types = String(req.query.types || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (types.length) filter.type = { $in: types };

  const notifications = await Notification.find(filter)
    .populate('fromUser', 'name avatarUrl')
    .populate('relatedId')
    .sort({ createdAt: -1 })
    .limit(50);

  // Who sent it, as a profile: so the app can open it and show "Follow back".
  const fromIds = [...new Set(notifications.map((n) => n.fromUser?._id && String(n.fromUser._id)).filter(Boolean))];
  let profiles = new Map();
  if (fromIds.length) {
    const [creators, brands] = await Promise.all([
      CreatorProfile.find({ user: { $in: fromIds } }).select('user slug followers'),
      BrandProfile.find({ user: { $in: fromIds } }).select('user slug followers'),
    ]);
    const me = String(req.user._id);
    const shape = (p, role) => ({ role, profileId: p._id, slug: p.slug, isFollowing: p.followers.some((f) => String(f) === me) });
    profiles = new Map([...creators.map((c) => [String(c.user), shape(c, 'creator')]), ...brands.map((b) => [String(b.user), shape(b, 'brand')])]);
  }
  const items = notifications.map((n) => ({ ...n.toObject(), fromProfile: (n.fromUser && profiles.get(String(n.fromUser._id))) || null }));

  const unreadCount = await Notification.countDocuments({ user: req.user._id, isRead: false, ...(types.length && { type: { $in: types } }) });

  return new ApiResponse(200, { notifications: items, unreadCount }, 'Notifications fetched').send(res);
});

const markAsRead = catchAsync(async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { isRead: true },
    { new: true }
  );
  if (!notification) throw ApiError.notFound('Notification not found');
  return new ApiResponse(200, notification, 'Marked as read').send(res);
});

const markAllAsRead = catchAsync(async (req, res) => {
  await Notification.updateMany({ user: req.user._id, isRead: false }, { isRead: true });
  return new ApiResponse(200, null, 'All notifications marked as read').send(res);
});

module.exports = { getMyNotifications, markAsRead, markAllAsRead };