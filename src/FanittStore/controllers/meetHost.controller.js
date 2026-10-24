// File: src/FanittStore/controllers/meetHost.controller.js
const mongoose = require('mongoose');
const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const ApiError = require('../../utils/apiError');
const meetRoom = require('../services/meetRoom.service');
const attendance = require('../services/attendance.service');
const { LiveStream } = require('../models');

// Host controls for Virtual Meets, and "who attended" reports for meets and
// live streams. Every route here checks the caller is the host.

const identityOf = (body) => {
  const id = body?.identity;
  return id === undefined || id === null || id === '' ? null : String(id).slice(0, 64);
};

/** POST /api/store/meets/:id/host/mute { identity?, kind: 'audio'|'video' } — no identity = everyone. */
const mute = catchAsync(async (req, res) => {
  const kind = req.body?.kind === 'video' ? 'video' : 'audio';
  const result = await meetRoom.hostMute(req.user, req.params.id, { identity: identityOf(req.body), kind });
  const what = kind === 'video' ? 'Camera turned off' : 'Muted';
  return new ApiResponse(200, result, identityOf(req.body) ? what : `${what} for everyone`).send(res);
});

/** POST /api/store/meets/:id/host/remove { identity } */
const remove = catchAsync(async (req, res) => {
  const result = await meetRoom.hostRemove(req.user, req.params.id, { identity: identityOf(req.body) });
  return new ApiResponse(200, result, 'Removed from the meeting').send(res);
});

/** POST /api/store/meets/:id/host/lock { locked } */
const lock = catchAsync(async (req, res) => {
  const result = await meetRoom.hostLock(req.user, req.params.id, { locked: req.body?.locked === true });
  return new ApiResponse(200, result, result.locked ? 'Meeting locked' : 'Meeting unlocked').send(res);
});

/** GET /api/store/meets/:id/host/participants */
const participants = catchAsync(async (req, res) => {
  const result = await meetRoom.hostParticipants(req.user, req.params.id);
  return new ApiResponse(200, result, 'Participants').send(res);
});

/** GET /api/store/meets/:id/attendance — host only. */
const meetAttendance = catchAsync(async (req, res) => {
  const result = await meetRoom.attendanceReport(req.user, req.params.id);
  return new ApiResponse(200, result, 'Attendance').send(res);
});

/** GET /api/store/me/lives/:id/attendance — the creator's own live. */
const liveAttendance = catchAsync(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Live not found');
  const live = await LiveStream.findById(req.params.id).select('host');
  if (!live) throw ApiError.notFound('Live not found');
  if (String(live.host) !== String(req.user._id)) throw ApiError.forbidden('Only the host can see who watched');
  const result = await attendance.report({ kind: 'live', ref: live._id });
  return new ApiResponse(200, result, 'Attendance').send(res);
});

module.exports = { mute, remove, lock, participants, meetAttendance, liveAttendance };