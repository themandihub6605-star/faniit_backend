const ScreenEvent = require('../models/ScreenEvent.model');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

// App screen analytics.
//   POST /api/analytics/events          — the app sends screen visits in batches
//   GET  /api/analytics/admin/screens   — admin report (time per screen, traffic, drop-off)

const MAX_EVENTS = 200;
const MIN_MS = 300; // shorter = a redirect hop, not a real visit
const MAX_MS = 30 * 60 * 1000; // one visit counts at most 30 min (phone left open)
const ROLES = ['creator', 'brand', 'fan', 'agency', 'admin', 'guest'];
const TZ = 'Asia/Kolkata';

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** POST /api/analytics/events { installId, sessionId, platform, appVersion, events: [{ screen, durationMs, startedAt }] } */
const ingestEvents = catchAsync(async (req, res) => {
  const body = req.body || {};
  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
  const sessionId = str(body.sessionId, 64);
  const installId = str(body.installId, 64);
  if (!sessionId || !installId) throw ApiError.badRequest('sessionId and installId are required');

  const now = Date.now();
  const oldest = now - 7 * 24 * 60 * 60 * 1000;
  const user = req.user || null;
  const role = user && ROLES.includes(user.role) ? user.role : 'guest';
  const base = {
    visitor: user ? String(user._id) : `d:${installId}`,
    user: user ? user._id : null,
    role,
    sessionId,
    platform: str(body.platform, 20),
    appVersion: str(body.appVersion, 20),
  };

  const rows = [];
  for (const e of events) {
    const screen = str(e?.screen, 80);
    const durationMs = Math.round(Number(e?.durationMs));
    const startedAt = new Date(Number(e?.startedAt));
    if (!screen || !Number.isFinite(durationMs) || durationMs < MIN_MS) continue;
    const t = startedAt.getTime();
    if (!Number.isFinite(t) || t < oldest || t > now + 5 * 60 * 1000) continue;
    rows.push({ ...base, screen, durationMs: Math.min(durationMs, MAX_MS), startedAt });
  }

  if (rows.length) await ScreenEvent.insertMany(rows, { ordered: false });
  return new ApiResponse(200, { saved: rows.length }, 'Saved').send(res);
});

/** GET /api/analytics/admin/screens?days=7|30|90&role= */
const screenReport = catchAsync(async (req, res) => {
  const days = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
  const role = ROLES.includes(req.query.role) ? req.query.role : null;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const match = { startedAt: { $gte: since } };
  if (role) match.role = role;

  const [result] = await ScreenEvent.aggregate([
    { $match: match },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              views: { $sum: 1 },
              totalMs: { $sum: '$durationMs' },
              visitors: { $addToSet: '$visitor' },
              sessions: { $addToSet: '$sessionId' },
            },
          },
          { $project: { _id: 0, views: 1, totalMs: 1, visitors: { $size: '$visitors' }, sessions: { $size: '$sessions' } } },
        ],
        screens: [
          {
            $group: {
              _id: '$screen',
              views: { $sum: 1 },
              totalMs: { $sum: '$durationMs' },
              visitors: { $addToSet: '$visitor' },
            },
          },
          { $project: { _id: 0, screen: '$_id', views: 1, totalMs: 1, visitors: { $size: '$visitors' } } },
          { $sort: { totalMs: -1 } },
          { $limit: 100 },
        ],
        daily: [
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: TZ } },
              views: { $sum: 1 },
              totalMs: { $sum: '$durationMs' },
              visitors: { $addToSet: '$visitor' },
              sessions: { $addToSet: '$sessionId' },
            },
          },
          { $project: { _id: 0, date: '$_id', views: 1, totalMs: 1, visitors: { $size: '$visitors' }, sessions: { $size: '$sessions' } } },
          { $sort: { date: 1 } },
        ],
        hours: [
          { $group: { _id: { $hour: { date: '$startedAt', timezone: TZ } }, views: { $sum: 1 } } },
          { $project: { _id: 0, hour: '$_id', views: 1 } },
          { $sort: { hour: 1 } },
        ],
        roles: [
          { $group: { _id: '$role', totalMs: { $sum: '$durationMs' }, visitors: { $addToSet: '$visitor' } } },
          { $project: { _id: 0, role: '$_id', totalMs: 1, visitors: { $size: '$visitors' } } },
          { $sort: { totalMs: -1 } },
        ],
        // The last screen of each session = where people leave the app.
        exits: [
          { $sort: { sessionId: 1, startedAt: 1 } },
          { $group: { _id: '$sessionId', screen: { $last: '$screen' }, screens: { $sum: 1 } } },
          { $group: { _id: '$screen', sessions: { $sum: 1 }, bounces: { $sum: { $cond: [{ $eq: ['$screens', 1] }, 1, 0] } } } },
          { $project: { _id: 0, screen: '$_id', sessions: 1, bounces: 1 } },
          { $sort: { sessions: -1 } },
          { $limit: 15 },
        ],
      },
    },
  ]).allowDiskUse(true);

  const totals = result.totals[0] || { views: 0, totalMs: 0, visitors: 0, sessions: 0 };
  const grandMs = totals.totalMs || 0;

  // Today's active users (India time).
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const today = result.daily.find((d) => d.date === todayKey);

  // Fill missing days with zeros so the chart has no gaps.
  const byDate = new Map(result.daily.map((d) => [d.date, d]));
  const daily = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
    daily.push(byDate.get(key) || { date: key, views: 0, totalMs: 0, visitors: 0, sessions: 0 });
  }

  const byHour = new Map(result.hours.map((h) => [h.hour, h.views]));
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, views: byHour.get(hour) || 0 }));

  const totalSessions = totals.sessions || 0;
  return new ApiResponse(
    200,
    {
      range: { days, since, role },
      totals: {
        ...totals,
        activeToday: today?.visitors || 0,
        avgSessionMs: totalSessions ? Math.round(grandMs / totalSessions) : 0,
        screensPerSession: totalSessions ? Math.round((totals.views / totalSessions) * 10) / 10 : 0,
      },
      screens: result.screens.map((s) => ({
        ...s,
        avgMs: s.views ? Math.round(s.totalMs / s.views) : 0,
        sharePct: grandMs ? Math.round((s.totalMs / grandMs) * 1000) / 10 : 0,
      })),
      daily,
      hours,
      roles: result.roles.map((r) => ({ ...r, sharePct: grandMs ? Math.round((r.totalMs / grandMs) * 1000) / 10 : 0 })),
      exits: result.exits.map((e) => ({ ...e, sharePct: totalSessions ? Math.round((e.sessions / totalSessions) * 1000) / 10 : 0 })),
    },
    'Screen analytics'
  ).send(res);
});

module.exports = { ingestEvents, screenReport };