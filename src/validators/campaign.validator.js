const { z } = require('zod');

const createCampaignSchema = z.object({
  title: z.string().min(3),
  description: z.string().min(10).max(2000),
  category: z.string().min(1, 'Category is required'),
  budget: z.number().min(100, 'Budget must be at least ₹1'),
  durationLabel: z.string().optional(),
  location: z.string().default('Remote'),
  creatorRequirement: z.string().optional(),
});

const applyCampaignSchema = z.object({
  pitch: z.string().max(1000).optional(),
});

module.exports = { createCampaignSchema, applyCampaignSchema };
