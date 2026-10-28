// File: src/routes/report.routes.js
const express = require('express');
const router = express.Router();

const c = require('../controllers/report.controller');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { ROLES } = require('../constants/enums');

const admin = [protect, authorize(ROLES.ADMIN)];

router.post('/', protect, c.createReport);
router.get('/mine', protect, c.myReports);

router.get('/admin', ...admin, c.adminList);
router.patch('/admin/:id', ...admin, c.adminResolve);

module.exports = router;