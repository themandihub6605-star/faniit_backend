const { User } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

const updateMe = catchAsync(async (req, res) => {
  const { name, phone } = req.body;

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { $set: { ...(name && { name }), ...(phone && { phone }) } },
    { new: true, runValidators: true }
  );

  return new ApiResponse(200, user.toSafeObject(), 'Profile updated').send(res);
});

const updateAvatar = catchAsync(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No file uploaded');

  const avatarUrl = req.file.path;
  const user = await User.findByIdAndUpdate(req.user._id, { avatarUrl }, { new: true });

  return new ApiResponse(200, { avatarUrl: user.avatarUrl }, 'Avatar updated').send(res);
});

const getUserById = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  return new ApiResponse(200, user.toSafeObject(), 'User fetched').send(res);
});

const deleteMe = catchAsync(async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { isActive: false });
  return new ApiResponse(200, null, 'Account deactivated').send(res);
});

module.exports = { updateMe, updateAvatar, getUserById, deleteMe };
