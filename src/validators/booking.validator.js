const { z } = require('zod');

const createBookingSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
});

const verifyPaymentSchema = z.object({
  bookingId: z.string().min(1),
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

module.exports = { createBookingSchema, verifyPaymentSchema };
