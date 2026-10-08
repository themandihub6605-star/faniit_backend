const express = require('express');

// Fanitt Store — everything for the creator store lives in this folder.
//
//   /api/store/...                  creators, buyers and public pages (routes/store.routes.js)
//   /api/store/admin/...            admin panel (routes/admin.routes.js)
//   /api/store/shop/...             physical products: cart, checkout, orders (routes/commerce.routes.js)
//   /api/store/admin/shop/...       admin: physical products & orders (routes/adminCommerce.routes.js)
//   /api/store/livekit/webhook      LiveKit events (wired in app.js, needs the raw body)
//
// Mounted from src/routes/index.js; background jobs started from server.js.
// Debugging: every store log line starts with [FanittStore] — see utils/logger.js.

require('./models'); // register the Store models with mongoose

const router = express.Router();
router.use('/admin/shop', require('./routes/adminCommerce.routes')); // physical products & orders (admin)
router.use('/admin', require('./routes/admin.routes'));
router.use('/shop', require('./routes/commerce.routes')); // physical products, cart, checkout, orders
router.use('/', require('./routes/store.routes'));

module.exports = router;
module.exports.startJobs = () => require('./services/jobs.service').start();
module.exports.liveKitWebhook = (req, res) => require('./controllers/webhook.controller').handleLiveKitWebhook(req, res);