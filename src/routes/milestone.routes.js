const express = require('express');
const router = express.Router();

const {
  getMilestonesForCampaign,
  initiateMilestoneFunding,
  verifyMilestonePayment,
  submitMilestone,
  approveMilestone,
} = require('../controllers/milestone.controller');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { ROLES } = require('../constants/enums');

// Mount this router at /api/campaigns/:campaignId/milestones for the list
// route, and /api/milestones for everything else — see the mounting note
// below. If your app.js only supports one mount point per router file,
// split this into two small router files instead; noted in the delivery
// message since I can't see app.js/index.js to confirm your convention.

router.get('/campaigns/:campaignId/milestones', protect, getMilestonesForCampaign);

router.post('/milestones/:id/fund', protect, authorize(ROLES.BRAND), initiateMilestoneFunding);
router.post('/milestones/:id/verify-payment', protect, authorize(ROLES.BRAND), verifyMilestonePayment);
router.patch('/milestones/:id/submit', protect, authorize(ROLES.CREATOR), submitMilestone);
router.patch('/milestones/:id/approve', protect, authorize(ROLES.BRAND), approveMilestone);

module.exports = router;