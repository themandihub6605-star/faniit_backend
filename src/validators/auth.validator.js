const { z } = require('zod');
const { ROLES } = require('../constants/enums');

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  phone: z.string().optional(),
  role: z.enum([ROLES.FAN, ROLES.CREATOR, ROLES.BRAND, ROLES.AGENCY]).default(ROLES.FAN),
  // Optional. When given it must be exactly 8 characters: 2 letters + 6 letters/digits (e.g. CRK7F3QX).
  referralCode: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}[A-Za-z0-9]{6}$/, 'Referral code must be exactly 8 characters')
      .transform((v) => v.toUpperCase())
      .optional()
  ),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

module.exports = { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema };