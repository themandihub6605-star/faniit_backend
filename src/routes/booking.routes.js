const express = require('express');
const router = express.Router();

const { createBooking, verifyBookingPayment, getMyBookings, cancelBooking } = require('../controllers/booking.controller');
const { protect } = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { createBookingSchema, verifyPaymentSchema } = require('../validators/booking.validator');

router.post('/', protect, validate(createBookingSchema), createBooking);
router.post('/verify-payment', protect, validate(verifyPaymentSchema), verifyBookingPayment);
router.get('/me', protect, getMyBookings);
router.patch('/:id/cancel', protect, cancelBooking);

module.exports = router;
