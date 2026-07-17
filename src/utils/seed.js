require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { Category, User } = require('../models');
const generateSlug = require('./slugify');
const { ROLES } = require('../constants/enums');

const CATEGORIES = [
  { label: 'Fitness & Health', icon: 'Dumbbell' },
  { label: 'Music Production', icon: 'Music2' },
  { label: 'Personal Finance', icon: 'PiggyBank' },
  { label: 'Art & Design', icon: 'Palette' },
  { label: 'Comedy', icon: 'Mic2' },
  { label: 'Career Mentorship', icon: 'Briefcase' },
  { label: 'Cooking', icon: 'ChefHat' },
  { label: 'Gaming', icon: 'Gamepad2' },
  { label: 'Photography', icon: 'Camera' },
  { label: 'Business Coaching', icon: 'TrendingUp' },
];

async function seed() {
  await connectDB();

  console.log('[seed] Seeding categories...');
  for (const cat of CATEGORIES) {
    await Category.findOneAndUpdate(
      { label: cat.label },
      { ...cat, slug: generateSlug(cat.label) },
      { upsert: true, new: true }
    );
  }
  console.log(`[seed] ${CATEGORIES.length} categories ready`);

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@fanitt.com';
  const existingAdmin = await User.findOne({ email: adminEmail });

  if (!existingAdmin) {
    await User.create({
      name: 'Fanitt Admin',
      email: adminEmail,
      password: process.env.ADMIN_PASSWORD || 'ChangeMe123!',
      role: ROLES.ADMIN,
      roles: [ROLES.ADMIN],
      isEmailVerified: true,
    });
    console.log(`[seed] Admin user created: ${adminEmail} (change the password immediately)`);
  } else {
    console.log('[seed] Admin user already exists, skipping');
  }

  console.log('[seed] Done');
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
