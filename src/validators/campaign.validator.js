const { z } = require('zod');
const { CAMPAIGN_TYPE, LOCATION_TYPE, GENDER_TARGET } = require('../constants/enums');

const createDraftCampaignSchema = z.object({
  title: z.string().min(3, 'Campaign name is required'),
  campaignType: z.nativeEnum(CAMPAIGN_TYPE).default(CAMPAIGN_TYPE.PAID),
  locationType: z.nativeEnum(LOCATION_TYPE).default(LOCATION_TYPE.PAN_INDIA),
  locationValue: z.string().optional(),
});

const updateDraftCampaignSchema = z.object({
  title: z.string().min(3).optional(),
  campaignType: z.nativeEnum(CAMPAIGN_TYPE).optional(),
  locationType: z.nativeEnum(LOCATION_TYPE).optional(),
  locationValue: z.string().optional(),
  costPerInfluencer: z.number().min(0).optional(),
  description: z.string().min(10, 'Description is too short').max(2000).optional(),
  category: z.string().optional(),
  creatorRequirement: z.string().optional(),
  durationLabel: z.string().optional(),
  influencerCategories: z.array(z.string()).optional(),
  genderTarget: z.array(z.nativeEnum(GENDER_TARGET)).optional(),
  ageRange: z
    .object({
      min: z.number().min(13).max(100),
      max: z.number().min(13).max(100),
    })
    .refine((v) => v.max >= v.min, { message: 'Max age must be greater than or equal to min age' })
    .optional(),
  minFollowers: z.number().min(0).optional(),
  maxInfluencers: z.number().min(1).optional(),
  dos: z.array(z.string()).optional(),
  donts: z.array(z.string()).optional(),
  deliverables: z
    .object({
      reel: z.number().min(0).optional(),
      story: z.number().min(0).optional(),
      post: z.number().min(0).optional(),
    })
    .optional(),
});

const addProductSchema = z.object({
  name: z.string().min(1, 'Product name is required'),
  description: z.string().optional().default(''),
  quantity: z.coerce.number().int().min(1).default(1),
  price: z.coerce.number().min(0, 'Price must be a positive number'),
});

const applyCampaignSchema = z.object({
  pitch: z.string().max(1000).optional(),
  quotedAmount: z.number().min(0).optional(),
  deliverables: z.array(z.string()).optional(),
});

module.exports = {
  createDraftCampaignSchema,
  updateDraftCampaignSchema,
  addProductSchema,
  applyCampaignSchema,
};