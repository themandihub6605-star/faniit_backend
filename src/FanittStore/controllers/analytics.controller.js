const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const { LIMITS } = require('../constants');
const storeService = require('../services/store.service');
const analytics = require('../services/analytics.service');
const { pageParams } = require('../utils/text');

function daysParam(query) {
  const days = parseInt(query.days, 10);
  if ([7, 30, 90, 365].includes(days)) return Math.min(days, LIMITS.ANALYTICS_MAX_DAYS);
  return 30;
}

/** GET /api/store/me/analytics?days=7|30|90|365 */
const getMyAnalytics = catchAsync(async (req, res) => {
  const store = await storeService.requireMyStore(req.user._id);
  const data = await analytics.creatorAnalytics(store, daysParam(req.query));
  return new ApiResponse(200, data, 'Analytics').send(res);
});

/** GET /api/store/me/customers?page= */
const getMyCustomers = catchAsync(async (req, res) => {
  await storeService.requireMyStore(req.user._id);
  const { page, limit } = pageParams(req.query);
  return new ApiResponse(200, await analytics.customers(req.user._id, { page, limit }), 'Customers').send(res);
});

/** GET /api/store/admin/analytics?days= */
const getPlatformAnalytics = catchAsync(async (req, res) => {
  const data = await analytics.platformAnalytics(daysParam(req.query));
  return new ApiResponse(200, data, 'Platform analytics').send(res);
});

module.exports = { getMyAnalytics, getMyCustomers, getPlatformAnalytics, daysParam };
