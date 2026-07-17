const express = require('express');
const router = express.Router();

const { linkCreatorToAgency, getMyDashboard, updateMyProfile } = require('../controllers/agency.controller');
const { protect } = require('../middlewares/auth.middleware');

router.post('/link-creator', protect, linkCreatorToAgency);
router.get('/me/dashboard', protect, getMyDashboard);
router.patch('/me', protect, updateMyProfile);

module.exports = router;
