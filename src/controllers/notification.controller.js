const { Notification } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

const getMyNotifications = catchAsync(async (req, res) => {
  const { unreadOnly } = req.query;
  const filter = { user: req.user._id, ...(unreadOnly === 'true' && { isRead: false }) };

  const notifications = await Notification.find(filter).sort({ createdAt: -1 }).limit(50);
  const unreadCount = await Notification.countDocuments({ user: req.user._id, isRead: false });

  return new ApiResponse(200, { notifications, unreadCount }, 'Notifications fetched').send(res);
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
