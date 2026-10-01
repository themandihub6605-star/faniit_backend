const { Broadcast } = require('../models');
const broadcastService = require('../services/broadcast.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

function parseRoles(value) {
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      list = value.split(',');
    }
  }
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((r) => String(r).trim()).filter((r) => Broadcast.AUDIENCE_ROLES.includes(r)))];
}

function cleanLink(value) {
  const link = String(value || '').trim();
  if (!link) return '';
  if (link.startsWith('/')) return link.slice(0, 500);
  try {
    const url = new URL(link);
    if (url.protocol === 'https:' || url.protocol === 'http:') return link.slice(0, 500);
  } catch {
    // fall through
  }
  throw ApiError.badRequest('Link must be a full https:// URL or a website path like /communities');
}

/**
 * POST /api/admin/notifications/broadcast  (multipart or JSON)
 * title, message, roles[] (empty = everyone), testEmail?, link?, imageUrl? or image file,
 * scheduledAt? (ISO — in the future = scheduled, otherwise sent right away)
 */
const createBroadcast = catchAsync(async (req, res) => {
  const title = String(req.body.title || '').trim();
  const message = String(req.body.message || '').trim();
  if (!title || !message) throw ApiError.badRequest('Title and message are required');
  if (title.length > 100) throw ApiError.badRequest('Title can be up to 100 characters');
  if (message.length > 500) throw ApiError.badRequest('Message can be up to 500 characters');

  // Old admin panel sent a single `role`.
  const roles = parseRoles(req.body.roles ?? (req.body.role ? [req.body.role] : []));
  const testEmail = String(req.body.testEmail || '').trim().toLowerCase();
  const link = cleanLink(req.body.link);
  const imageUrl = req.file?.path || String(req.body.imageUrl || '').trim();

  let scheduledAt = new Date();
  if (req.body.scheduledAt) {
    scheduledAt = new Date(req.body.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) throw ApiError.badRequest('Scheduled time is invalid');
    if (scheduledAt.getTime() > Date.now() + 365 * 24 * 3600 * 1000) throw ApiError.badRequest('You can schedule up to a year ahead');
  }
  const isScheduled = scheduledAt.getTime() > Date.now() + 30 * 1000;

  const audience = await broadcastService.countAudience({ roles, testEmail });
  if (audience === 0) {
    throw ApiError.badRequest(testEmail ? 'No account found with that email' : 'No users match this audience');
  }

  const broadcast = await Broadcast.create({
    title,
    message,
    imageUrl,
    link,
    roles: testEmail ? [] : roles,
    testEmail,
    status: isScheduled ? 'scheduled' : 'sending',
    scheduledAt: isScheduled ? scheduledAt : new Date(),
    stats: { targeted: audience },
    createdBy: req.user._id,
  });

  if (!isScheduled) {
    // Deliver in the background so big audiences don't time out the request.
    broadcastService.deliver(broadcast).catch((err) => console.error('[broadcast] send failed:', err.message));
  }

  return new ApiResponse(
    201,
    { broadcast, sentTo: audience },
    isScheduled ? `Scheduled for ${scheduledAt.toISOString()}` : `Sending to ${audience} user(s)`
  ).send(res);
});

/** GET /api/admin/notifications/audience?roles=creator,brand&testEmail= */
const audienceCount = catchAsync(async (req, res) => {
  const roles = parseRoles(req.query.roles || []);
  const testEmail = String(req.query.testEmail || '').trim().toLowerCase();
  const count = await broadcastService.countAudience({ roles, testEmail });
  return new ApiResponse(200, { count }, 'Audience counted').send(res);
});

/** GET /api/admin/notifications/broadcasts?status=&page= */
const listBroadcasts = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const filter = {};
  if (Broadcast.STATUSES.includes(req.query.status)) filter.status = req.query.status;

  const [broadcasts, total] = await Promise.all([
    Broadcast.find(filter)
      .populate('createdBy', 'name email')
      .sort({ status: 1, scheduledAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Broadcast.countDocuments(filter),
  ]);
  // Upcoming first, newest history after.
  broadcasts.sort((a, b) => {
    const rank = (s) => (s === 'scheduled' ? 0 : s === 'sending' ? 1 : 2);
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return a.status === 'scheduled' ? a.scheduledAt - b.scheduledAt : b.scheduledAt - a.scheduledAt;
  });
  return new ApiResponse(200, { broadcasts, total, page, pages: Math.ceil(total / limit) }, 'Broadcasts fetched').send(res);
});

async function findScheduled(id) {
  const broadcast = await Broadcast.findById(id);
  if (!broadcast) throw ApiError.notFound('Broadcast not found');
  if (broadcast.status !== 'scheduled') throw ApiError.badRequest('Only scheduled notifications can be changed');
  return broadcast;
}

/** PATCH /api/admin/notifications/broadcasts/:id/cancel */
const cancelBroadcast = catchAsync(async (req, res) => {
  const broadcast = await findScheduled(req.params.id);
  broadcast.status = 'cancelled';
  await broadcast.save();
  return new ApiResponse(200, broadcast, 'Scheduled notification cancelled').send(res);
});

/** POST /api/admin/notifications/broadcasts/:id/send-now */
const sendNow = catchAsync(async (req, res) => {
  const broadcast = await findScheduled(req.params.id);
  broadcast.status = 'sending';
  broadcast.scheduledAt = new Date();
  await broadcast.save();
  broadcastService.deliver(broadcast).catch((err) => console.error('[broadcast] send failed:', err.message));
  return new ApiResponse(200, broadcast, 'Sending now').send(res);
});

/** PATCH /api/admin/notifications/broadcasts/:id/reschedule  { scheduledAt } */
const reschedule = catchAsync(async (req, res) => {
  const broadcast = await findScheduled(req.params.id);
  const when = new Date(req.body.scheduledAt);
  if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() + 30 * 1000) {
    throw ApiError.badRequest('Pick a time at least a minute from now');
  }
  broadcast.scheduledAt = when;
  await broadcast.save();
  return new ApiResponse(200, broadcast, 'Rescheduled').send(res);
});

module.exports = { createBroadcast, audienceCount, listBroadcasts, cancelBroadcast, sendNow, reschedule };