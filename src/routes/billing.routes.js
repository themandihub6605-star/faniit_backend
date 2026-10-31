// File: src/routes/billing.routes.js
const express = require('express');
const router = express.Router();

const billing = require('../controllers/billing.controller');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { ROLES } = require('../constants/enums');

router.get('/config', protect, billing.getConfig);
router.get('/invoices', protect, billing.listMyInvoices);
router.get('/invoices/:id', protect, billing.getInvoice);
router.post('/invoices/:id/email', protect, billing.resendInvoice);

// Admin → Billing & GST
router.get('/admin/settings', protect, authorize(ROLES.ADMIN), billing.adminGetSettings);
router.patch('/admin/settings', protect, authorize(ROLES.ADMIN), billing.adminUpdateSettings);
router.get('/admin/invoices', protect, authorize(ROLES.ADMIN), billing.adminListInvoices);

module.exports = router;
