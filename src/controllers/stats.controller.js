const { User, Booking, Transaction } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const { ROLES, TRANSACTION_STATUS } = require('../constants/enums');

/** GET /api/stats/public — real, non-sensitive counters for the public homepage (TrustBar) */
const getPublicStats = catchAsync(async (req, res) => {
  const [sessionsBooked, activeCreators, activeBrands] = await Promise.all([
    Booking.countDocuments({ status: { $in: ['confirmed', 'completed'] } }),
    User.countDocuments({ role: ROLES.CREATOR }),
    User.countDocuments({ role: ROLES.BRAND }),
  ]);

  const paidOutAgg = await Transaction.aggregate([
    { $match: { status: { $in: [TRANSACTION_STATUS.SUCCESS, TRANSACTION_STATUS.RELEASED] }, to: { $ne: null } } },
    { $group: { _id: null, total: { $sum: '$netAmount' } } },
  ]);

  return new ApiResponse(
    200,
    {
      sessionsBooked,
      activeCreators,
      activeBrands,
      totalPaidOut: paidOutAgg[0]?.total || 0, // in paise
    },
    'Public stats fetched'
  ).send(res);
});

module.exports = { getPublicStats };