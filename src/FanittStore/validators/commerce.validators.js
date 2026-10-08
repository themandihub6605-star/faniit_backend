const { z } = require('zod');
const mongoose = require('mongoose');
const { SHOP_CATEGORIES } = require('../shop.constants');

// Physical products, cart, addresses, checkout and orders.
// All money is in paise.

const trimmed = (max) => z.string().trim().max(max);
const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const paise = (max = 10000000) => z.number().int().min(0).max(max);

// ---------- seller: products ----------

const variantSchema = z.object({
  _id: objectId.optional(), // keep the id when editing, so carts still point to it
  label: z.string().trim().min(1, 'Option name is required').max(30),
  stock: z.number().int().min(0).max(100000),
});

const productBase = {
  title: z.string().trim().min(3, 'Title must be at least 3 characters').max(120),
  description: trimmed(5000).optional(),
  highlights: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
  category: z.enum(SHOP_CATEGORIES).optional(),
  mrp: paise().optional(),
  price: z.number().int().min(100, 'Price must be at least ₹1').max(10000000),
  stock: z.number().int().min(0).max(100000).optional(),
  variantName: trimmed(20).optional(),
  variants: z.array(variantSchema).max(20).optional(),
  deliveryCharge: paise(1000000).optional(),
  deliveryDays: trimmed(30).optional(),
  codAvailable: z.boolean().optional(),
  returnPolicy: trimmed(300).optional(),
};

const checkVariants = (data, ctx) => {
  if (data.variants?.length) {
    const labels = data.variants.map((v) => v.label.toLowerCase());
    if (new Set(labels).size !== labels.length) ctx.addIssue({ code: 'custom', path: ['variants'], message: 'Each option must have a different name' });
    if (data.variantName !== undefined && !data.variantName) ctx.addIssue({ code: 'custom', path: ['variantName'], message: 'Name the options, e.g. "Size"' });
  }
  if (data.mrp && data.price && data.mrp > 0 && data.mrp < data.price) {
    ctx.addIssue({ code: 'custom', path: ['mrp'], message: 'MRP must be more than the selling price' });
  }
};

const shopProductCreateSchema = z.object(productBase).superRefine(checkVariants);
const shopProductUpdateSchema = z.object(productBase).partial().superRefine(checkVariants);

const imageOrderSchema = z.object({ images: z.array(z.string().trim().url()).min(1).max(4) });
const imageRemoveSchema = z.object({ url: z.string().trim().min(1) });

// ---------- buyer ----------

const cartAddSchema = z.object({
  productId: objectId,
  variantId: objectId.nullable().optional(),
  qty: z.number().int().min(1).max(10).default(1),
});

const cartUpdateSchema = z.object({ qty: z.number().int().min(0).max(10) });

const addressSchema = z.object({
  name: z.string().trim().min(2, 'Enter the full name').max(80),
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, '').replace(/^\+?91/, ''))
    .refine((v) => /^[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number'),
  line1: z.string().trim().min(3, 'Enter house no. / building / street').max(200),
  line2: trimmed(200).optional(),
  landmark: trimmed(100).optional(),
  city: z.string().trim().min(2, 'Enter the city').max(60),
  state: z.string().trim().min(2, 'Enter the state').max(60),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit pincode'),
  label: z.enum(['home', 'work', 'other']).optional(),
  isDefault: z.boolean().optional(),
});

const addressUpdateSchema = addressSchema.partial();

const checkoutLinesSchema = z
  .object({
    source: z.enum(['cart', 'buy_now']).default('cart'),
    productId: objectId.optional(),
    variantId: objectId.nullable().optional(),
    qty: z.number().int().min(1).max(10).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.source === 'buy_now' && !d.productId) ctx.addIssue({ code: 'custom', path: ['productId'], message: 'Choose a product' });
  });

const checkoutSchema = z
  .object({
    source: z.enum(['cart', 'buy_now']).default('cart'),
    productId: objectId.optional(),
    variantId: objectId.nullable().optional(),
    qty: z.number().int().min(1).max(10).optional(),
    addressId: objectId,
    paymentMethod: z.enum(['cod', 'online']),
  })
  .superRefine((d, ctx) => {
    if (d.source === 'buy_now' && !d.productId) ctx.addIssue({ code: 'custom', path: ['productId'], message: 'Choose a product' });
  });

const verifySchema = z.object({
  razorpayOrderId: z.string().trim().min(1),
  razorpayPaymentId: z.string().trim().min(1),
  razorpaySignature: z.string().trim().min(1),
});

const cancelSchema = z.object({ reason: z.string().trim().min(3, 'Tell us why').max(300) });

// ---------- seller: orders ----------

const shipSchema = z.object({
  courier: trimmed(60).optional(),
  trackingId: trimmed(80).optional(),
  trackingUrl: z.union([z.string().trim().url('Enter a valid link').max(500), z.literal('')]).optional(),
  note: trimmed(300).optional(),
});

// ---------- admin ----------

const shopSettingsSchema = z.object({
  shopEnabled: z.boolean().optional(),
  shopFeePercent: z.number().min(0).max(50).optional(),
  shopCodEnabled: z.boolean().optional(),
  shopOnlineEnabled: z.boolean().optional(),
  shopCodMaxAmount: paise(100000000).optional(),
});

const reasonSchema = z.object({ reason: z.string().trim().min(3).max(300) });

module.exports = {
  shopProductCreateSchema,
  shopProductUpdateSchema,
  imageOrderSchema,
  imageRemoveSchema,
  cartAddSchema,
  cartUpdateSchema,
  addressSchema,
  addressUpdateSchema,
  checkoutLinesSchema,
  checkoutSchema,
  verifySchema,
  cancelSchema,
  shipSchema,
  shopSettingsSchema,
  reasonSchema,
};