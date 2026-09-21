require('dotenv').config();

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 5000,
  // comma-separated list, e.g. "http://localhost:5173,http://localhost:5174"
  clientUrls: (process.env.CLIENT_URLS || 'http://localhost:5173,http://localhost:5174')
    .split(',')
    .map((url) => url.trim()),

  mongoUri: process.env.MONGO_URI,

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  },

  platform: {
    commissionPercent: Number(process.env.PLATFORM_COMMISSION_PERCENT || 18),
    agencyDefaultCommissionPercent: Number(process.env.AGENCY_DEFAULT_COMMISSION_PERCENT || 5),
  },

  zoom: {
    accountId: process.env.ZOOM_ACCOUNT_ID,
    clientId: process.env.ZOOM_CLIENT_ID,
    clientSecret: process.env.ZOOM_CLIENT_SECRET,
    sdkKey: process.env.ZOOM_SDK_KEY,
    sdkSecret: process.env.ZOOM_SDK_SECRET,
    // Server-to-Server OAuth apps can only create meetings "as" an actual
    // licensed user on your Zoom account — not an arbitrary creator's email.
    // Every session is created under this one platform account.
    hostEmail: process.env.ZOOM_HOST_EMAIL,
  },

  uploadDir: process.env.UPLOAD_DIR || 'uploads',

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },

  // Media storage — replacing Cloudinary. Images/documents go to R2
  // (S3-compatible object storage, zero egress fees), video goes to
  // Cloudflare Stream (handles transcoding/playback the way Cloudinary's
  // video pipeline did).
  cloudflare: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    // R2 (images/documents) — from R2 > Manage API Tokens in the dashboard
    r2: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      bucketName: process.env.R2_BUCKET_NAME,
      // The bucket's public base URL — either the free *.r2.dev URL
      // (enable "Public Access" on the bucket to get one) or your own
      // custom domain connected to the bucket. No trailing slash.
      publicUrl: process.env.R2_PUBLIC_URL,
    },
    // Stream (video) — API Tokens page, needs Stream:Edit permission
    streamApiToken: process.env.CLOUDFLARE_STREAM_API_TOKEN,
  },
};