// File: src/routes/booking.routes.js
const express = require('express');
const router = express.Router();

const { createBooking, verifyBookingPayment, getMyBookings, cancelBooking, declineBooking } = require('../controllers/booking.controller');
const { protect } = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { createBookingSchema, verifyPaymentSchema } = require('../validators/booking.validator');

router.post('/', protect, validate(createBookingSchema), createBooking);
router.post('/verify-payment', protect, validate(verifyPaymentSchema), verifyBookingPayment);
router.get('/me', protect, getMyBookings);
router.patch('/:id/cancel', protect, cancelBooking);
router.patch('/:id/decline', protect, declineBooking); // "I won't join" after a reschedule

module.exports = router;