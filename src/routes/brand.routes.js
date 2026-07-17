const express = require('express');
const router = express.Router();

const {
  getBrandById,
  getBrandBySlug,
  getMyProfile,
  updateMyProfile,
  getMyDashboard,
  uploadLogo,
  followBrand,
} = require('../controllers/brand.controller');
const { protect } = require('../middlewares/auth.middleware');
const { uploadImage } = require('../middlewares/upload.middleware');

router.get('/me', protect, getMyProfile);
router.get('/me/dashboard', protect, getMyDashboard);
router.patch('/me', protect, updateMyProfile);
router.post('/upload-logo', protect, uploadImage('fanitt/brand-logos').single('logo'), uploadLogo);
router.post('/:id/follow', protect, followBrand);
router.get('/slug/:slug', getBrandBySlug);
router.get('/:id', getBrandById);

module.exports = router;
