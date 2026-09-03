const express = require('express');
const router = express.Router();

const {
  initiateMilestoneFunding,
  verifyMilestonePayment,
  submitMilestone,
  approveMilestone,
  requestMilestoneChanges,
  raiseMilestoneDispute,
} = require('../controllers/milestone.controller');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { uploadAttachments } = require('../middlewares/upload.middleware');
const { ROLES } = require('../constants/enums');

// Mounted at /api/milestones in routes/index.js — paths below are relative
// to that prefix. The one milestone route that lists a campaign's
// milestones lives in campaign.routes.js instead (GET /api/campaigns/:id/milestones).

router.post('/:id/fund', protect, authorize(ROLES.BRAND), initiateMilestoneFunding);
router.post('/:id/verify-payment', protect, authorize(ROLES.BRAND), verifyMilestonePayment);

router.patch(
  '/:id/submit',
  protect,
  authorize(ROLES.CREATOR),
  uploadAttachments('fanitt/milestone-submissions').array('files', 5),
  submitMilestone
);

router.patch('/:id/approve', protect, authorize(ROLES.BRAND), approveMilestone);

router.patch(
  '/:id/request-changes',
  protect,
  authorize(ROLES.BRAND),
  uploadAttachments('fanitt/milestone-change-requests').array('files', 5),
  requestMilestoneChanges
);

router.post(
  '/:id/dispute',
  protect,
  authorize(ROLES.BRAND),
  uploadAttachments('fanitt/dispute-evidence').array('files', 5),
  raiseMilestoneDispute
);

module.exports = router;