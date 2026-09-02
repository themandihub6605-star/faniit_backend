const express = require('express');
const router = express.Router();

const {
  initiateMilestoneFunding,
  verifyMilestonePayment,
  submitMilestone,
  approveMilestone,
} = require('../controllers/milestone.controller');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { ROLES } = require('../constants/enums');

// Mounted at /api/milestones in routes/index.js (router.use('/milestones',
// require('./milestone.routes'))) — paths below are relative to that
// prefix, matching every other route file's convention. The one milestone
// route that lists a campaign's milestones lives in campaign.routes.js
// instead (GET /api/campaigns/:id/milestones), since it's scoped by
// campaign rather than by milestone id.

router.post('/:id/fund', protect, authorize(ROLES.BRAND), initiateMilestoneFunding);
router.post('/:id/verify-payment', protect, authorize(ROLES.BRAND), verifyMilestonePayment);
router.patch('/:id/submit', protect, authorize(ROLES.CREATOR), submitMilestone);
router.patch('/:id/approve', protect, authorize(ROLES.BRAND), approveMilestone);

module.exports = router;