const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');
const path = require('path');

const env = require('./config/env');
const routes = require('./routes');
const { errorHandler, notFound } = require('./middlewares/error.middleware');
const { generalLimiter } = require('./middlewares/rateLimiter.middleware');
const { handleWebhook } = require('./controllers/payment.controller');

const app = express();

// --- security & core middleware ---
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  cors({
    origin: (origin, callback) => {
      // allow non-browser requests (curl, Postman, Razorpay webhook) with no origin header
      if (!origin || env.clientUrls.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked for origin: ${origin}`));
      }
    },
    credentials: true,
  })
);
app.use(compression());
app.use(cookieParser());
app.use(mongoSanitize());
app.use(morgan(env.env === 'development' ? 'dev' : 'combined'));
app.use(generalLimiter);

// --- Razorpay webhook needs the RAW body for signature verification,
//     so it's wired up BEFORE the JSON parser, only for this one path ---
app.post(
  '/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  (req, res, next) => {
    req.rawBody = req.body; // Buffer
    req.body = JSON.parse(req.body.toString('utf8'));
    next();
  },
  handleWebhook
);

// --- standard body parsing for everything else ---
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// --- static file serving for local uploads (swap for S3/Cloudinary in production) ---
app.use(`/${env.uploadDir}`, express.static(path.join(process.cwd(), env.uploadDir)));

// --- API routes ---
app.use('/api', routes);

// --- 404 + centralized error handling ---
app.use(notFound);
app.use(errorHandler);

module.exports = app;
