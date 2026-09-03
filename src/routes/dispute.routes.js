const express = require('express');
const router = express.Router();

const { listOpenDisputes, getDispute, resolveDispute } = require('../controllers/dispute.controller');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { ROLES } = require('../constants/enums');

// Mounted at /api/disputes in routes/index.js. Admin-only throughout —
// brands/creators interact with disputes through the milestone endpoints
// (raise via POST /milestones/:id/dispute), not these.
router.get('/', protect, authorize(ROLES.ADMIN), listOpenDisputes);
router.get('/:id', protect, authorize(ROLES.ADMIN), getDispute);
router.patch('/:id/resolve', protect, authorize(ROLES.ADMIN), resolveDispute);

module.exports = router;