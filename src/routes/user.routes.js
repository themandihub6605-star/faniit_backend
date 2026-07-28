const express = require('express');
const router = express.Router();

const { updateMe, updateAvatar, getUserById, deleteMe, getMyReferrals, changePassword } = require('../controllers/user.controller');
const { protect } = require('../middlewares/auth.middleware');
const { uploadImage } = require('../middlewares/upload.middleware');

router.patch('/me', protect, updateMe);
router.patch('/me/password', protect, changePassword);
router.patch('/me/avatar', protect, uploadImage('fanitt/avatars').single('avatar'), updateAvatar);
router.get('/me/referrals', protect, getMyReferrals);
router.delete('/me', protect, deleteMe);
router.get('/:id', getUserById);

module.exports = router;