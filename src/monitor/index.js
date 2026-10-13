// Admin monitoring: tracking middleware + the /admin/monitor API.
// Wire-up (routes/index.js):
//   router.use(require('../monitor').tracker);                 // first line after the router is created
//   router.use('/admin/monitor', require('../monitor').routes); // before router.use('/admin', …)
//
// `tracker` also runs the feature gate (see features.js): it answers
// GET /api/features and turns /api/store off when the admin switches the
// Fanitt Store off. No change to routes/index.js is needed for that.
const { tracker: trackRequest } = require('./tracker');
const { featureGate } = require('./features');

function tracker(req, res, next) {
  featureGate(req, res, () => trackRequest(req, res, next));
}

module.exports = {
  tracker,
  get routes() {
    return require('./monitor.routes');
  },
};