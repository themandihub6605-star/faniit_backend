// File: src/FanittStore/controllers/webhook.controller.js
const { LiveStream } = require('../models');
const { LIVE_STATUS } = require('../constants');
const livekit = require('../services/livekit.service');
const callService = require('../services/call.service');
const attendance = require('../services/attendance.service');
const mongoose = require('mongoose');
const log = require('../utils/logger');

// POST /api/store/livekit/webhook — LiveKit server events.
// Registered in app.js BEFORE the JSON parser because the signature is
// checked against the raw body.
//
// Viewer counts and attendance (who joined, for how long) come from
// participant_joined / participant_left; a room closing ends a call that is
// still marked active and closes every open attendance visit.

async function handleLiveKitWebhook(req, res) {
  let event;
  try {
    event = await livekit.parseWebhook(req.body.toString('utf8'), req.get('Authorization'));
  } catch (err) {
    log.warn('webhook.rejected', { message: err?.message });
    return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
  }

  try {
    const roomName = event.room?.name || '';
    const identity = event.participant?.identity || '';
    let meta = {};
    try {
      meta = JSON.parse(event.participant?.metadata || '{}');
    } catch {
      meta = {};
    }

    if (roomName.startsWith('live_')) {
      const live = await LiveStream.findOne({ roomName }).select('_id host status stats');
      if (live && meta.role !== 'host' && identity !== String(live.host)) {
        if (event.event === 'participant_joined') {
          const updated = await LiveStream.findOneAndUpdate(
            { _id: live._id },
            { $inc: { 'stats.currentViewers': 1, 'stats.totalJoins': 1 } },
            { new: true }
          );
          if (updated.stats.currentViewers > updated.stats.peakViewers) {
            await LiveStream.updateOne(
              { _id: live._id, 'stats.peakViewers': { $lt: updated.stats.currentViewers } },
              { $set: { 'stats.peakViewers': updated.stats.currentViewers } }
            );
          }
        } else if (event.event === 'participant_left') {
          await LiveStream.updateOne({ _id: live._id, 'stats.currentViewers': { $gt: 0 } }, { $inc: { 'stats.currentViewers': -1 } });
        }
      }
      if (live && event.event === 'room_finished' && live.status === LIVE_STATUS.LIVE) {
        await LiveStream.updateOne({ _id: live._id, status: LIVE_STATUS.LIVE }, { $set: { 'stats.currentViewers': 0 } });
      }
      // Attendance for the host's "who watched" list.
      if (live) {
        const isHost = meta.role === 'host' || identity === String(live.host);
        if (event.event === 'participant_joined' && identity) {
          await attendance.onJoin({ kind: 'live', ref: live._id, identity, name: event.participant?.name, isHost });
        } else if (event.event === 'participant_left' && identity) {
          await attendance.onLeave({ kind: 'live', ref: live._id, identity });
        } else if (event.event === 'room_finished') {
          await attendance.closeAll({ kind: 'live', ref: live._id });
        }
      }
    } else if (roomName.startsWith('meet-')) {
      // Virtual Meet rooms are named meet-<sessionId>.
      const sessionId = roomName.slice('meet-'.length);
      if (mongoose.isValidObjectId(sessionId)) {
        if (event.event === 'participant_joined' && identity && !event.participant?.permission?.hidden) {
          await attendance.onJoin({ kind: 'meet', ref: sessionId, identity, name: event.participant?.name, isHost: meta.role === 'host' });
        } else if (event.event === 'participant_left' && identity) {
          await attendance.onLeave({ kind: 'meet', ref: sessionId, identity });
        } else if (event.event === 'room_finished') {
          await attendance.closeAll({ kind: 'meet', ref: sessionId });
        }
      }
    } else if (roomName.startsWith('call_') && event.event === 'room_finished') {
      await callService.onRoomFinished(roomName);
    }
  } catch (err) {
    // Always 200 so LiveKit doesn't retry forever; the log has the details.
    log.error('webhook.handle_failed', err, { event: event?.event, room: event?.room?.name });
  }
  return res.json({ success: true });
}

module.exports = { handleLiveKitWebhook };