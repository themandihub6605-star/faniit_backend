const express = require('express');
const router = express.Router();

const {
  listCampaigns,
  getCampaignById,
  createCampaign,
  applyToCampaign,
  getMyProposals,
  getApplications,
  decideApplication,
  toggleSaveCampaign,
  getSavedCampaigns,
  initiateEscrowFunding,
  verifyEscrowPayment,
  submitWork,
  approveWork,
} = require('../controllers/campaign.controller');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const validate = require('../middlewares/validate.middleware');
const { createCampaignSchema, applyCampaignSchema } = require('../validators/campaign.validator');
const { ROLES } = require('../constants/enums');

// specific static paths BEFORE the /:id catch-all
router.get('/proposals/me', protect, authorize(ROLES.CREATOR), getMyProposals);
router.get('/saved/me', protect, getSavedCampaigns);

router.get('/', listCampaigns);
router.post('/', protect, authorize(ROLES.BRAND), validate(createCampaignSchema), createCampaign);

router.post('/:id/apply', protect, authorize(ROLES.CREATOR), validate(applyCampaignSchema), applyToCampaign);
router.post('/:id/save', protect, toggleSaveCampaign);
router.get('/:id/applications', protect, authorize(ROLES.BRAND), getApplications);
router.patch('/:id/applications/:appId', protect, authorize(ROLES.BRAND), decideApplication);

router.post('/:id/fund-escrow', protect, authorize(ROLES.BRAND), initiateEscrowFunding);
router.post('/:id/verify-escrow-payment', protect, authorize(ROLES.BRAND), verifyEscrowPayment);

router.patch('/:id/submit', protect, authorize(ROLES.CREATOR), submitWork);
router.patch('/:id/approve', protect, authorize(ROLES.BRAND), approveWork);

// generic :id GET must come after the specific static GET routes above
router.get('/:id', getCampaignById);

module.exports = router;