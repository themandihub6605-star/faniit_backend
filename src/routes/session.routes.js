const express = require('express');
const router = express.Router();

const {
  listSessions,
  getSessionById,
  createSession,
  updateSession,
  cancelSession,
  getJoinToken,
  goLive,
  endLive,
  uploadBanner,
} = require('../controllers/session.controller');
const { protect } = require('../middlewares/auth.middleware');
const { authorize } = require('../middlewares/role.middleware');
const validate = require('../middlewares/validate.middleware');
const { uploadImage } = require('../middlewares/upload.middleware');
const { createSessionSchema } = require('../validators/session.validator');
const { ROLES } = require('../constants/enums');

router.get('/', listSessions);
router.post('/upload-banner', protect, authorize(ROLES.CREATOR), uploadImage('fanitt/session-banners').single('banner'), uploadBanner);
router.post('/', protect, authorize(ROLES.CREATOR), validate(createSessionSchema), createSession);
router.get('/:id', getSessionById);
router.patch('/:id', protect, authorize(ROLES.CREATOR), updateSession);
router.delete('/:id', protect, authorize(ROLES.CREATOR), cancelSession);
router.get('/:id/join-token', protect, getJoinToken);
router.patch('/:id/go-live', protect, authorize(ROLES.CREATOR), goLive);
router.patch('/:id/end-live', protect, authorize(ROLES.CREATOR), endLive);

module.exports = router;