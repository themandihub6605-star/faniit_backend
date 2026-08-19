const express = require('express');
const router = express.Router();

const {
  listCampaigns,
  getCampaignById,
  getMyDraftCampaign,
  createDraftCampaign,
  updateDraftCampaign,
  addProduct,
  removeProduct,
  uploadCampaignMedia,
  getFeePreview,
  publishCampaign,
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
const { uploadImage, uploadMedia } = require('../middlewares/upload.middleware');
const {
  createDraftCampaignSchema,
  updateDraftCampaignSchema,
  addProductSchema,
  publishCampaignSchema,
  applyCampaignSchema,
} = require('../validators/campaign.validator');
const { ROLES } = require('../constants/enums');

// specific static paths BEFORE the /:id catch-all
router.get('/proposals/me', protect, authorize(ROLES.CREATOR), getMyProposals);
router.get('/saved/me', protect, getSavedCampaigns);
router.get('/fee-preview', protect, authorize(ROLES.BRAND), getFeePreview);

router.get('/', listCampaigns);
router.post('/draft', protect, authorize(ROLES.BRAND), validate(createDraftCampaignSchema), createDraftCampaign);

router.get('/:id/draft', protect, authorize(ROLES.BRAND), getMyDraftCampaign);
router.patch('/:id', protect, authorize(ROLES.BRAND), validate(updateDraftCampaignSchema), updateDraftCampaign);

router.post(
  '/:id/products',
  protect,
  authorize(ROLES.BRAND),
  uploadImage('fanitt/campaign-products').single('image'),
  validate(addProductSchema),
  addProduct
);
router.delete('/:id/products/:productId', protect, authorize(ROLES.BRAND), removeProduct);

router.post(
  '/:id/media',
  protect,
  authorize(ROLES.BRAND),
  uploadMedia('fanitt/campaign-media').fields([
    { name: 'campaignImage', maxCount: 1 },
    { name: 'media', maxCount: 10 },
  ]),
  uploadCampaignMedia
);

router.post('/:id/publish', protect, authorize(ROLES.BRAND), validate(publishCampaignSchema), publishCampaign);

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