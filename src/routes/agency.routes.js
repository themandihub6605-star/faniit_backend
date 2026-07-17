const express = require('express');
const router = express.Router();

const {
  getMyProfile,
  updateMyProfile,
  uploadDocument,
  linkCreatorToAgency,
  linkBrandToAgency,
  getMyDashboard,
  getMyReferrals,
} = require('../controllers/agency.controller');
const { protect } = require('../middlewares/auth.middleware');
const { uploadImage } = require('../middlewares/upload.middleware');

router.get('/me', protect, getMyProfile);
router.patch('/me', protect, updateMyProfile);
router.post('/upload-document', protect, uploadImage('fanitt/agency-documents').single('document'), uploadDocument);
router.get('/me/dashboard', protect, getMyDashboard);
router.get('/me/referrals', protect, getMyReferrals);
router.post('/link-creator', protect, linkCreatorToAgency);
router.post('/link-brand', protect, linkBrandToAgency);

module.exports = router;
