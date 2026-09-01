/**
 * Point 12: auto-release sweep for milestones whose review window has
 * elapsed (SiteSettings.milestoneAutoReleaseDays). Run this on a
 * schedule — e.g. once a day via cron (Linux/Mac) or Task Scheduler
 * (Windows):
 *
 *   node scripts/autoReleaseMilestones.js
 *
 * Example daily cron entry (runs at 3 AM server time):
 *   0 3 * * * cd /path/to/fanitt-backend && node scripts/autoReleaseMilestones.js >> logs/auto-release.log 2>&1
 *
 * Deliberately a standalone script (not wired into the main server
 * process) so it doesn't need an extra scheduling dependency like
 * node-cron — if your project already uses one, this function
 * (milestoneService.runAutoReleaseSweep) can just as easily be called
 * from a node-cron job inside server.js instead of run as a separate
 * script. Either way works; this is the safer default since it doesn't
 * assume what's already installed.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const milestoneService = require('../services/milestone.service');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`[auto-release] Connected. Starting sweep at ${new Date().toISOString()}`);

  const { released, failed } = await milestoneService.runAutoReleaseSweep();

  console.log(`[auto-release] Released ${released.length} milestone(s): ${released.join(', ') || '(none)'}`);
  if (failed.length > 0) {
    console.error(`[auto-release] ${failed.length} milestone(s) FAILED to release:`);
    failed.forEach((f) => console.error(`  - ${f.milestoneId}: ${f.error}`));
  }

  await mongoose.disconnect();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[auto-release] Sweep crashed:', err);
  process.exit(1);
});