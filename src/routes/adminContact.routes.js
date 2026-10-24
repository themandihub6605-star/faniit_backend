// File: src/routes/adminContact.routes.js
const express = require('express');
const ctrl = require('../controllers/contact.controller');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { ROLES } = require('../constants/enums');

const router = express.Router();

// Mounted at /api/admin/contact-messages — admins only.
router.use(protect, authorize(ROLES.ADMIN));

router.get('/', ctrl.listMessages);
router.patch('/:id', ctrl.updateMessage);
router.delete('/:id', ctrl.deleteMessage);

module.exports = router;