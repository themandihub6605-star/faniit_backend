// File: src/routes/terms.routes.js
const express = require('express');
const router = express.Router();

const c = require('../controllers/terms.controller');
const { protect } = require('../middlewares/auth.middleware');

router.get('/status', protect, c.status);
router.post('/accept', protect, c.accept);

module.exports = router;