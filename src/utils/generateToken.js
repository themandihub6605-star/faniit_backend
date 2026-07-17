const jwt = require('jsonwebtoken');
const env = require('../config/env');

function generateAccessToken(userId, role) {
  return jwt.sign({ id: userId, role }, env.jwt.secret, { expiresIn: env.jwt.expiresIn });
}

function generateRefreshToken(userId) {
  return jwt.sign({ id: userId }, env.jwt.refreshSecret, { expiresIn: env.jwt.refreshExpiresIn });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.secret);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwt.refreshSecret);
}

module.exports = { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken };
