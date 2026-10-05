const express = require('express');
const { getPublicLayout } = require('../controllers/homeLayout.controller');

const router = express.Router();

// What the app home shows, in order (managed in the admin panel).
router.get('/layout', getPublicLayout);

module.exports = router;