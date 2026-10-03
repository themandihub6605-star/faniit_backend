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

// Editing a session: only these fields. Price and type can't change after
// people may have booked. A new scheduledAt postpones the session.
const updateSessionSchema = z
  .object({
    title: z.string().min(3).max(120).optional(),
    description: z.string().max(1000).optional(),
    scheduledAt: z.string().datetime({ message: 'scheduledAt must be a valid ISO date' }).optional(),
    durationMinutes: z.number().min(5).max(480).optional(),
    maxParticipants: z.number().min(1).max(10000).optional(),
    coverImageUrl: z.string().optional(),
    rescheduleNote: z.string().max(300).optional(),
  })
  .strict();

module.exports = { createSessionSchema, updateSessionSchema };