const { z } = require('zod');
const { SESSION_TYPES } = require('../constants/enums');

const createSessionSchema = z.object({
  title: z.string().min(3),
  description: z.string().max(1000).optional(),
  category: z.string().min(1, 'Category is required'),
  type: z.enum([SESSION_TYPES.FREE, SESSION_TYPES.PAID, SESSION_TYPES.ONE_TO_ONE]),
  price: z.number().min(0).default(0),
  scheduledAt: z.string().datetime({ message: 'scheduledAt must be a valid ISO date' }),
  durationMinutes: z.number().min(5).max(480),
  maxParticipants: z.number().min(1).max(10000).default(100),
  coverImageUrl: z.string().optional(),
});

module.exports = { createSessionSchema };