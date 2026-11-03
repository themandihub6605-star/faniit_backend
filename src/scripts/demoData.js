/**
 * Demo data for internal testing.
 *
 *   node scripts/demoData.js seed     -> creates demo creators + 50 products,
 *                                        50 communities, 25 live sessions, 50 stream lives
 *   node scripts/demoData.js status   -> shows how much demo data exists
 *   node scripts/demoData.js clear    -> deletes ALL demo data (and orders, bookings,
 *                                        memberships, transactions linked to it)
 *
 * Every demo creator has an email ending in @fanitt.demo. Everything else is
 * found through those users, so `clear` never touches real data.
 */
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');

const User = require('../models/User.model');
const CreatorProfile = require('../models/CreatorProfile.model');
const Category = require('../models/Category.model');
const Community = require('../models/Community.model');
const CommunityMembership = require('../models/CommunityMembership.model');
const CommunityPost = require('../models/CommunityPost.model');
const CommunityComment = require('../models/CommunityComment.model');
const CommunityMessage = require('../models/CommunityMessage.model');
const Session = require('../models/Session.model');
const Booking = require('../models/Booking.model');
const Transaction = require('../models/Transaction.model');
const Notification = require('../models/Notification.model');
const { Store, DigitalProduct, LiveStream, StoreOrder } = require('../FanittStore/models');

const DEMO_DOMAIN = 'fanitt.demo';
const DEMO_EMAIL = /@fanitt\.demo$/i;

// ---------- content ---------------------------------------------------------

const CREATORS = [
  { name: 'Aarav Mehta', title: 'Fitness Coach', store: 'Aarav Fit Studio', avatar: 12 },
  { name: 'Priya Sharma', title: 'Content Creator & Reels Coach', store: 'Priya Creates', avatar: 47 },
  { name: 'Rohan Verma', title: 'Photographer', store: 'Rohan Clicks', avatar: 13 },
  { name: 'Ananya Iyer', title: 'Classical Dancer', store: 'Ananya Dance Room', avatar: 44 },
  { name: 'Kabir Singh', title: 'Music Producer', store: 'Kabir Beats', avatar: 15 },
  { name: 'Sneha Kapoor', title: 'Nutritionist', store: 'Eat Smart with Sneha', avatar: 45 },
  { name: 'Arjun Nair', title: 'Stock Market Educator', store: 'Arjun Money School', avatar: 33 },
  { name: 'Meera Joshi', title: 'Illustrator & Designer', store: 'Meera Draws', avatar: 49 },
  { name: 'Vikram Rao', title: 'Travel Vlogger', store: 'Vikram Wanders', avatar: 52 },
  { name: 'Isha Gupta', title: 'Yoga Teacher', store: 'Isha Yoga Space', avatar: 48 },
];

const PRODUCTS = [
  ['30-Day Home Workout Plan', 'guide'], ['Fat Loss Meal Planner', 'template'], ['Reels Hook Library (300 Hooks)', 'ebook'],
  ['Instagram Growth Masterclass', 'course'], ['Lightroom Presets Pack – Golden Hour', 'template'], ['Mobile Photography Basics', 'course'],
  ['Bharatanatyam for Beginners', 'video'], ['Kathak Footwork Drills', 'video'], ['Lo-fi Beat Pack Vol. 1', 'audio'],
  ['FL Studio Starter Course', 'course'], ['Vegetarian High-Protein Recipes', 'ebook'], ['Healthy Tiffin Ideas for Office', 'guide'],
  ['Stock Market for Beginners', 'course'], ['Monthly Budget Sheet (Excel)', 'template'], ['Options Trading Notes', 'ebook'],
  ['Procreate Brush Set – Ink & Watercolor', 'template'], ['Character Design Workbook', 'ebook'], ['Logo Design Crash Course', 'video'],
  ['Budget Travel Guide: Himachal', 'guide'], ['Goa on ₹10,000 Itinerary', 'guide'], ['Morning Yoga Flow (20 min)', 'video'],
  ['Pranayama Audio Sessions', 'audio'], ['Resume Template Pack', 'template'], ['YouTube Script Templates', 'template'],
  ['Video Editing in CapCut', 'course'], ['Thumbnail Design Secrets', 'guide'], ['Guitar Chords Cheat Sheet', 'ebook'],
  ['Bollywood Vocal Warm-ups', 'audio'], ['Notion Life Planner', 'template'], ['Freelancing Starter Kit', 'guide'],
  ['Brand Deal Pitch Templates', 'template'], ['Personal Finance 101', 'ebook'], ['Street Photography Field Guide', 'guide'],
  ['Wedding Photography Poses', 'ebook'], ['Mindful Meditation Pack', 'audio'], ['Weight Gain Diet for Skinny Guys', 'guide'],
  ['Calisthenics Zero to Pull-up', 'course'], ['Handwriting Improvement Sheets', 'template'], ['Spoken English in 30 Days', 'course'],
  ['Canva Social Media Kit', 'template'], ['Podcast Starter Guide', 'guide'], ['Mixing & Mastering Basics', 'video'],
  ['Watercolor Landscapes', 'video'], ['Interview Prep Handbook', 'ebook'], ['Mutual Funds Explained', 'ebook'],
  ['Trek Packing Checklist', 'template'], ['Desk Stretch Routine', 'video'], ['Skin Care on a Budget', 'guide'],
  ['Hindi Poetry Collection', 'ebook'], ['Creator Media Kit Template', 'template'],
];

const COMMUNITIES = [
  'Fit India Squad', 'Reels Creators Club', 'Mobile Photographers India', 'Dance Lovers Circle', 'Bedroom Producers',
  'Healthy Eating Gang', 'Smart Investors Hub', 'Digital Artists Adda', 'Backpackers of India', 'Daily Yoga Circle',
  'Morning Runners', 'Home Chefs Corner', 'Book Readers Club', 'Startup Founders Room', 'Freelancers Network',
  'YouTube Growth Lab', 'Guitar Jam Room', 'Singers Riyaaz Group', 'Street Photography Walks', 'Wedding Shooters',
  'Budget Travellers', 'Mountain Trekkers', 'Calisthenics Crew', 'Meditation Mornings', 'Plant Parents India',
  'Coding Beginners', 'UI/UX Designers India', 'Stand-up Comedy Fans', 'Poetry & Shayari', 'Anime Fans India',
  'Gamers Lounge', 'Cricket Talks', 'Football Fanatics', 'Movie Buffs', 'Car & Bike Lovers',
  'Pet Lovers India', 'New Parents Circle', 'Study Together', 'UPSC Aspirants', 'Language Exchange',
  'Fashion on a Budget', 'Skincare Talk', 'Home Decor Ideas', 'Minimalist Living', 'Side Hustle Club',
  'Podcasters India', 'Video Editors Hub', 'Sketching Daily', 'Classical Music Circle', 'Weekend Cyclists',
];

const SESSIONS = [
  'Live Q&A: Building a Home Workout Habit', 'Reels Strategy Clinic', 'Portrait Lighting Live Demo', 'Kathak Basics Live Class',
  'Beat Making from Scratch', 'Meal Prep Sunday Live', 'Stock Market Doubts Session', 'Draw With Me: Character Sketch',
  'Travel Planning AMA', 'Evening Yoga & Breathwork', 'Instagram Profile Review', 'Photo Editing Walkthrough',
  'Bollywood Dance Workshop', 'Vocal Training Basics', 'Diet Myths Busted', 'SIP vs Lump Sum Explained',
  'Procreate Tips & Tricks', 'Solo Travel Safety Talk', 'Posture Fix Session', 'Content Calendar Planning',
  'Wedding Shoot Behind the Scenes', 'Freestyle Dance Jam', 'Mixing Feedback Session', 'Healthy Snacks Live Cook-along',
  'Budget Planning for Students',
];

const LIVES = [
  'Morning HIIT Live', 'Reels Editing Live', 'Golden Hour Photo Walk', 'Dance Practice Live', 'Making a Beat Live',
  'Cooking Healthy Paneer Bowl', 'Market Open Live Analysis', 'Live Painting Session', 'Live from Manali', 'Sunset Yoga Live',
  'Ask Me Anything – Fitness', 'Creator Chit-chat Night', 'Camera Gear Talk', 'Garba Steps Live', 'Studio Tour Live',
  'Protein Shake Recipes', 'Weekly Portfolio Review', 'Doodle Night', 'Street Food Tour Live', 'Guided Meditation Live',
  'Abs Burner Live', 'Trending Audio Breakdown', 'Night Photography Live', 'Semi-classical Practice', 'Guitar Covers Live',
  'Detox Drinks Live', 'Crypto vs Stocks Debate', 'Logo Design Live', 'Trek Diaries Live', 'Desk Yoga Live',
  'Leg Day Live', 'Hashtag Strategy Live', 'Editing Your Photos Live', 'Contemporary Dance Live', 'Singing Requests Live',
  'Weekly Diet Q&A', 'Tax Saving Tips Live', 'Fan Art Reactions', 'Packing for Ladakh Live', 'Stretching Live',
  'Full Body Workout Live', 'Collab Ideas Live', 'Food Photography Live', 'Folk Dance Live', 'Unplugged Music Night',
  'Breakfast Ideas Live', 'Budget Goals Live', 'Sketchbook Tour', 'Hidden Gems of Rajasthan', 'Bedtime Relaxation Live',
];

// ---------- helpers ---------------------------------------------------------

const img = (key, w, h) => `https://picsum.photos/seed/fanitt-${key}/${w}/${h}`;
const avatar = (n) => `https://i.pravatar.cc/400?img=${n}`;
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const pick = (arr, i) => arr[i % arr.length];
const hours = (h) => new Date(Date.now() + h * 3600 * 1000);
const tag = () => crypto.randomBytes(3).toString('hex');
const PRODUCT_PRICES = [0, 4900, 9900, 14900, 19900, 0, 29900, 4900, 9900, 49900];
const LIVE_PRICES = [0, 0, 0, 2900, 4900, 0, 9900, 0];
const SESSION_PRICES = [0, 4900, 9900, 0, 19900];

// ---------- commands --------------------------------------------------------

async function demoUsers() {
  const users = await User.find({ email: DEMO_EMAIL }).select('_id');
  const userIds = users.map((u) => u._id);
  const profiles = await CreatorProfile.find({ user: { $in: userIds } }).select('_id');
  const stores = await Store.find({ user: { $in: userIds } }).select('_id');
  return { userIds, profileIds: profiles.map((p) => p._id), storeIds: stores.map((s) => s._id) };
}

async function status() {
  const { userIds, profileIds, storeIds } = await demoUsers();
  const counts = {
    creators: userIds.length,
    stores: storeIds.length,
    products: await DigitalProduct.countDocuments({ owner: { $in: userIds } }),
    communities: await Community.countDocuments({ createdBy: { $in: userIds } }),
    liveSessions: await Session.countDocuments({ creator: { $in: profileIds } }),
    streamLives: await LiveStream.countDocuments({ host: { $in: userIds } }),
  };
  console.table(counts);
  return counts;
}

async function seed() {
  const existing = await User.countDocuments({ email: DEMO_EMAIL });
  if (existing) {
    console.log(`[demo] Demo data already exists (${existing} creators). Run "clear" first.`);
    return;
  }

  const categories = await Category.find({ isActive: true }).select('_id');
  const catId = (i) => (categories.length ? pick(categories, i)._id : undefined);
  const run = tag();

  // 1) creators + profiles + active stores
  const creators = [];
  for (let i = 0; i < CREATORS.length; i += 1) {
    const c = CREATORS[i];
    const user = await User.create({
      name: c.name,
      email: `demo${i + 1}@${DEMO_DOMAIN}`,
      password: crypto.randomBytes(16).toString('hex'),
      avatarUrl: avatar(c.avatar),
      role: 'creator',
      roles: ['fan', 'creator'],
      onboardingCompleted: true,
      isEmailVerified: true,
    });
    const profile = await CreatorProfile.create({
      user: user._id,
      slug: `${slugify(c.name)}-demo-${run}`,
      title: c.title,
      bio: `${c.title} sharing tips, live classes and resources every week.`,
      location: pick(['Mumbai', 'Delhi', 'Bengaluru', 'Pune', 'Jaipur', 'Kochi', 'Hyderabad'], i),
      languages: ['Hindi', 'English'],
      coverImageUrl: img(`cr-cover-${i}`, 1280, 720),
      followerCount: 500 + i * 137,
      verificationStatus: 'verified',
    });
    const store = await Store.create({
      user: user._id,
      creator: profile._id,
      slug: `${slugify(c.store)}-${run}`,
      name: c.store,
      tagline: `Courses, guides and lives by ${c.name.split(' ')[0]}`,
      about: `Welcome to ${c.store}. Everything here is made to help you learn faster.`,
      logoUrl: avatar(c.avatar),
      bannerUrl: img(`st-banner-${i}`, 1280, 720),
      kycStatus: 'verified',
      status: 'active',
      activatedAt: new Date(),
      termsAcceptedAt: new Date(),
      isOpen: true,
    });
    creators.push({ user, profile, store });
  }
  console.log(`[demo] ${creators.length} creators + stores`);

  // 2) 50 digital products (square covers)
  await DigitalProduct.insertMany(
    PRODUCTS.map(([title, category], i) => {
      const c = pick(creators, i);
      return {
        store: c.store._id,
        owner: c.user._id,
        title,
        description: `${title} — a practical, easy-to-follow resource. Made for beginners and busy people.`,
        category,
        coverUrl: img(`pr-${i}`, 800, 800),
        price: pick(PRODUCT_PRICES, i),
        status: 'published',
        publishedAt: new Date(Date.now() - i * 3600 * 1000),
        salesCount: (i * 7) % 40,
        views: 100 + ((i * 53) % 900),
      };
    })
  );
  console.log(`[demo] ${PRODUCTS.length} products`);

  // 3) 50 public communities (+ owner membership)
  for (let i = 0; i < COMMUNITIES.length; i += 1) {
    const c = pick(creators, i);
    const name = COMMUNITIES[i];
    const community = await Community.create({
      name,
      slug: `${slugify(name)}-${run}`,
      description: `A friendly space for ${name.toLowerCase()} — share, ask, learn and grow together.`,
      category: catId(i),
      coverImageUrl: img(`cm-cover-${i}`, 1280, 720),
      iconUrl: img(`cm-icon-${i}`, 400, 400),
      visibility: 'public',
      createdBy: c.user._id,
      isVerified: i % 4 === 0,
      isFeatured: i % 10 === 0,
      memberCount: 1,
      lastActivityAt: new Date(Date.now() - i * 1800 * 1000),
    });
    await CommunityMembership.create({ community: community._id, user: c.user._id, role: 'admin' });
  }
  console.log(`[demo] ${COMMUNITIES.length} communities`);

  // 4) 25 live sessions, spread over the next 1–14 days (16:9 covers)
  await Session.insertMany(
    SESSIONS.map((title, i) => {
      const c = pick(creators, i);
      const price = pick(SESSION_PRICES, i);
      return {
        creator: c.profile._id,
        title,
        description: `Join ${c.user.name} live — ask questions and learn together.`,
        category: catId(i),
        coverImageUrl: img(`se-${i}`, 1280, 720),
        type: price ? 'paid' : 'free',
        price,
        scheduledAt: hours(24 + i * 12),
        durationMinutes: pick([30, 45, 60], i),
        maxParticipants: pick([50, 100, 200], i),
      };
    })
  );
  console.log(`[demo] ${SESSIONS.length} live sessions`);

  // 5) 50 scheduled public stream lives (16:9 covers)
  await LiveStream.insertMany(
    LIVES.map((title, i) => {
      const c = pick(creators, i);
      return {
        store: c.store._id,
        host: c.user._id,
        title,
        description: `${c.user.name} is going live — come say hi!`,
        coverUrl: img(`lv-${i}`, 1280, 720),
        visibility: 'public',
        price: pick(LIVE_PRICES, i),
        status: 'scheduled',
        scheduledAt: hours(6 + i * 6),
        roomName: `live_${crypto.randomBytes(9).toString('hex')}`,
      };
    })
  );
  console.log(`[demo] ${LIVES.length} stream lives`);

  await status();
  console.log('[demo] Done ✅');
}

async function clear() {
  const { userIds, profileIds, storeIds } = await demoUsers();
  if (!userIds.length) {
    console.log('[demo] No demo data found. Nothing to delete.');
    return;
  }

  const communityIds = (await Community.find({ createdBy: { $in: userIds } }).select('_id')).map((x) => x._id);
  const sessionIds = (await Session.find({ creator: { $in: profileIds } }).select('_id')).map((x) => x._id);

  const del = async (label, model, filter) => {
    const r = await model.deleteMany(filter);
    console.log(`[demo] ${label}: ${r.deletedCount} deleted`);
  };

  await del('orders', StoreOrder, { $or: [{ seller: { $in: userIds } }, { store: { $in: storeIds } }] });
  await del('bookings', Booking, { session: { $in: sessionIds } });
  await del('transactions', Transaction, { $or: [{ to: { $in: userIds } }, { from: { $in: userIds } }] });
  await del('community messages', CommunityMessage, { community: { $in: communityIds } });
  await del('community comments', CommunityComment, { community: { $in: communityIds } });
  await del('community posts', CommunityPost, { community: { $in: communityIds } });
  await del('memberships', CommunityMembership, { community: { $in: communityIds } });
  await del('communities', Community, { _id: { $in: communityIds } });
  await del('live sessions', Session, { _id: { $in: sessionIds } });
  await del('stream lives', LiveStream, { host: { $in: userIds } });
  await del('products', DigitalProduct, { owner: { $in: userIds } });
  await del('stores', Store, { _id: { $in: storeIds } });
  await del('notifications', Notification, { user: { $in: userIds } });
  await del('creator profiles', CreatorProfile, { _id: { $in: profileIds } });
  await del('creators', User, { _id: { $in: userIds } });
  console.log('[demo] All demo data removed ✅');
}

async function main() {
  const cmd = process.argv[2];
  if (!['seed', 'clear', 'status'].includes(cmd)) {
    console.log('Usage: node scripts/demoData.js <seed|status|clear>');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  try {
    if (cmd === 'seed') await seed();
    if (cmd === 'clear') await clear();
    if (cmd === 'status') await status();
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('[demo] Failed:', err.message);
  mongoose.disconnect().finally(() => process.exit(1));
});