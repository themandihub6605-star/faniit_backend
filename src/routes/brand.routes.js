const express = require('express');
const router = express.Router();

const {
  listBrands,
  getBrandById,
  getBrandBySlug,
  getMyProfile,
  updateMyProfile,
  getMyDashboard,
  uploadLogo,
  followBrand,
} = require('../controllers/brand.controller');
const { protect, optionalAuth } = require('../middlewares/auth.middleware');
const { uploadImage } = require('../middlewares/upload.middleware');

// optionalAuth so tier-matched visibility (Point 5) can see who's asking
// — without requiring login, since this listing stays public either way.
router.get('/', optionalAuth, listBrands);
router.get('/me', protect, getMyProfile);
router.get('/me/dashboard', protect, getMyDashboard);
router.patch('/me', protect, updateMyProfile);
router.post('/upload-logo', protect, uploadImage('fanitt/brand-logos').single('logo'), uploadLogo);
router.post('/:id/follow', protect, followBrand);
router.get('/slug/:slug', getBrandBySlug);
router.get('/:id', getBrandById);

module.exports = router;