const callService = require('./call.service');
const { LiveStream } = require('../models');
const { LIVE_STATUS, LIMITS } = require('../constants');
const livekit = require('./livekit.service');
const log = require('../utils/logger');

// Background jobs for the store, started from server.js.
//  - call timeouts / auto-end
//  - lives left running for over 12 hours are closed

const LIVE_MAX_MS = 12 * 60 * 60 * 1000;
let timer = null;
let running = false;

async function tick() {
  if (running) return; // never overlap
  running = true;
  try {
    await callService.runTimeouts();
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
