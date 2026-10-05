const express = require('express');
const { listDocs, getDoc } = require('../controllers/legal.controller');

const router = express.Router();

// Public — Privacy Policy and Terms of Use for the app and website.
router.get('/', listDocs);
router.get('/:slug', getDoc);

module.exports = router;