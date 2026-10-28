// File: src/FanittStore/services/jobs.service.js
const callService = require('./call.service');
const { LiveStream } = require('../models');
const { LIVE_STATUS, LIMITS } = require('../constants');
const livekit = require('./livekit.service');
const log = require('../utils/logger');

// Background jobs for the store, started from server.js.
//  - call timeouts / auto-end
//  - lives left running for over 12 hours are closed
//  - shop checkouts not paid online in 30 minutes are released
//  - Virtual Meet reminders 15 minutes before the start
//  - Virtual Meets left running past their end + 1 h are closed
//  - Stream Live reminders, and scheduled lives never started are cancelled + refunded
//  - affiliate links checked weekly; broken ones flagged for the creator

const LIVE_MAX_MS = 12 * 60 * 60 * 1000;
let timer = null;
let running = false;

async function tick() {
  if (running) return; // never overlap
  running = true;
  try {
    await callService.runTimeouts();
    // Shop: online checkouts not paid in 30 minutes → stock back.
    await require('./commerce.service').expireUnpaid();
    // Paid communities: expire ended memberships, send renew reminders.
    await require('../../services/communityPaid.service').runSweep();
    // Virtual Meets: "starts in 15 minutes" to everyone who booked.
    await require('./meetRoom.service').sendReminders();
    // Virtual Meets the host never ended → closed after end + 1 h.
    await require('./meetRoom.service').autoEndOverdue();
    // Stream Live: "starts in 15 min" to ticket holders + host,
    // and scheduled lives never started → cancelled + refunded after 1 h.
    await require('./live.service').sendReminders();
    await require('./live.service').expireMissed();
    // Affiliate links: a few checked per run, each about once a week.
    await require('./affiliateLinks.service').checkSome();
    const stale = await LiveStream.find({ status: LIVE_STATUS.LIVE, startedAt: { $lt: new Date(Date.now() - LIVE_MAX_MS) } }).limit(20);
    for (const live of stale) {
      // eslint-disable-next-line no-await-in-loop
      await LiveStream.updateOne({ _id: live._id, status: LIVE_STATUS.LIVE }, { $set: { status: LIVE_STATUS.ENDED, endedAt: new Date(), 'stats.currentViewers': 0 } });
      // eslint-disable-next-line no-await-in-loop
      await livekit.closeRoom(live.roomName);
      log.info('live.auto_ended', { liveId: String(live._id) });
    }
  } catch (err) {
    log.error('jobs.tick_failed', err);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, LIMITS.JOB_INTERVAL_MS);
  setTimeout(tick, 5000);
  log.info('jobs.started', { everyMs: LIMITS.JOB_INTERVAL_MS });
}

module.exports = { start, tick };