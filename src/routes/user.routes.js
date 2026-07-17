const express = require('express');
const router = express.Router();

const { updateMe, updateAvatar, getUserById, deleteMe } = require('../controllers/user.controller');
const { protect } = require('../middlewares/auth.middleware');
const { uploadImage } = require('../middlewares/upload.middleware');

router.patch('/me', protect, updateMe);
router.patch('/me/avatar', protect, uploadImage('fanitt/avatars').single('avatar'), updateAvatar);
router.delete('/me', protect, deleteMe);
router.get('/:id', getUserById);

module.exports = router;