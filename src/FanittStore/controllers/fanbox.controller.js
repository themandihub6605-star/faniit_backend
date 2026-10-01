const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const { StoreOrder } = require('../models');
const { ORDER_ITEM, ORDER_STATUS, FANBOX } = require('../constants');
const settingsService = require('../services/settings.service');
const fanboxService = require('../services/fanbox.service');
const { order: serializeOrder } = require('../utils/serialize');
const { pageParams } = require('../utils/text');

/** GET /api/store/fanbox/config — amounts and fee for the send sheet. */
const getConfig = catchAsync(async (req, res) => {
  const settings = await settingsService.getSettings();
  return new ApiResponse(
    200,
    { presets: FANBOX.PRESETS, minAmount: FANBOX.MIN_AMOUNT, maxAmount: FANBOX.MAX_AMOUNT, feePercent: settings.fanboxFeePercent },
    'FanBox config'
  ).send(res);
});

/** POST /api/store/fanbox { creatorId | storeId, amount, message?, context?, payWith? } */
const send = catchAsync(async (req, res) => {
  const result = await fanboxService.startFanBox(req.user, req.body);
  return new ApiResponse(
    result.paid ? 201 : 200,
    { order: serializeOrder(result.order), paid: result.paid, razorpay: result.razorpay },
    result.paid ? 'FanBox sent 🎁' : 'Complete the payment'
  ).send(res);
});

/** GET /api/store/me/fanbox?page= — supporters and their messages (creator). */
const listReceived = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = { seller: req.user._id, itemType: ORDER_ITEM.FANBOX, status: ORDER_STATUS.PAID };
  const [orders, total, all] = await Promise.all([
    StoreOrder.find(filter).populate('buyer', 'name avatarUrl').sort({ paidAt: -1 }).skip(skip).limit(limit),
    StoreOrder.countDocuments(filter),
    StoreOrder.find(filter).select('amount creatorEarning buyer'),
  ]);
  const supporters = new Map();
  all.forEach((o) => {
    const key = String(o.buyer);
    supporters.set(key, (supporters.get(key) || 0) + o.amount);
  });
  return new ApiResponse(
    200,
    {
      fanbox: orders.map(serializeOrder),
      totals: {
        count: all.length,
        gross: all.reduce((s, o) => s + o.amount, 0),
        net: all.reduce((s, o) => s + (o.creatorEarning || 0), 0),
        supporters: supporters.size,
      },
      total,
      page,
      pages: Math.ceil(total / limit),
    },
    'FanBox received'
  ).send(res);
});

/** GET /api/store/fanbox/sent — FanBox I sent. */
const listSent = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = { buyer: req.user._id, itemType: ORDER_ITEM.FANBOX, status: { $in: [ORDER_STATUS.PAID, ORDER_STATUS.REFUNDED] } };
  const [orders, total] = await Promise.all([
    StoreOrder.find(filter).populate('seller', 'name avatarUrl').sort({ paidAt: -1 }).skip(skip).limit(limit),
    StoreOrder.countDocuments(filter),
  ]);
  return new ApiResponse(200, { fanbox: orders.map(serializeOrder), total, page, pages: Math.ceil(total / limit) }, 'FanBox sent').send(res);
});

module.exports = { getConfig, send, listReceived, listSent };
