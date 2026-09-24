const express = require('express');
const { verifyWebhook, receiveWebhook } = require('../controllers/whatsapp.controller');

const router = express.Router();

router.get('/webhook', verifyWebhook);
router.post('/webhook', receiveWebhook);

module.exports = router;