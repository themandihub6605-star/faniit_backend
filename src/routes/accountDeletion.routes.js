const express = require('express');
const router = express.Router();

const ctrl = require('../controllers/accountDeletion.controller');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const { ROLES } = require('../constants/enums');

// Mounted at /api/admin/account-deletions — admins only.
router.use(protect, authorize(ROLES.ADMIN));

router.get('/', ctrl.listDeletions);
router.patch('/:id/approve', ctrl.approveDeletion);
router.patch('/:id/reject', ctrl.rejectDeletion);

module.exports = router;