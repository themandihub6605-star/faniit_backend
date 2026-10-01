const express = require('express');

// Fanitt Store — everything for the creator store lives in this folder.
//
//   /api/store/...                  creators, buyers and public pages (routes/store.routes.js)
//   /api/store/admin/...            admin panel (routes/admin.routes.js)
//   /api/store/livekit/webhook      LiveKit events (wired in app.js, needs the raw body)
//
// Mounted from src/routes/index.js; background jobs started from server.js.
// Debugging: every store log line starts with [FanittStore] — see utils/logger.js.

require('./models'); // register the Store models with mongoose

const router = express.Router();
router.use('/admin', require('./routes/admin.routes'));
router.use('/', require('./routes/store.routes'));

module.exports = router;
module.exports.startJobs = () => require('./services/jobs.service').start();
module.exports.liveKitWebhook = (req, res) => require('./controllers/webhook.controller').handleLiveKitWebhook(req, res);
