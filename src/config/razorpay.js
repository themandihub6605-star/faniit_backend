const Razorpay = require('razorpay');
const env = require('./env');

const razorpay = new Razorpay({
  key_id: env.razorpay.keyId,
  key_secret: env.razorpay.keySecret,
});

module.exports = razorpay;
