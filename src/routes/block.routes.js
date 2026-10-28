// File: src/routes/block.routes.js
const express = require('express');
const router = express.Router();

const c = require('../controllers/block.controller');
const { protect } = require('../middlewares/auth.middleware');

router.get('/', protect, c.list);
router.get('/ids', protect, c.ids);
router.get('/status/:userId', protect, c.status);
router.post('/:userId', protect, c.block);
router.delete('/:userId', protect, c.unblock);

module.exports = router;