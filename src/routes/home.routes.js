const express = require('express');
const { getPublicLayout } = require('../controllers/homeLayout.controller');
const banners = require('../controllers/homeBanner.controller');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { uploadImage } = require('../middlewares/upload.middleware');
const { ROLES } = require('../constants/enums');

const router = express.Router();

// What the app home shows, in order (managed in the admin panel).
router.get('/layout', getPublicLayout);

// Home slider banners
router.get('/banners', banners.listPublic);
router.post('/banners/:id/click', banners.trackClick);

// Admin — manage banners
const admin = [protect, authorize(ROLES.ADMIN)];
const image = uploadImage('fanitt/home-banners').single('image');
router.get('/admin/banners', ...admin, banners.adminList);
router.post('/admin/banners', ...admin, image, banners.adminCreate);
router.put('/admin/banners/order', ...admin, banners.adminReorder);
router.patch('/admin/banners/:id', ...admin, image, banners.adminUpdate);
router.delete('/admin/banners/:id', ...admin, banners.adminDelete);

module.exports = router;