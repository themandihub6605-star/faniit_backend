const express = require('express');
const { protect, optionalAuth } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const analytics = require('../controllers/appAnalytics.controller');

const router = express.Router();

// App sends screen visits (works before login too).
router.post('/events', optionalAuth, analytics.ingestEvents);

// Admin report.
router.get('/admin/screens', protect, authorize('admin'), analytics.screenReport);

module.exports = router;