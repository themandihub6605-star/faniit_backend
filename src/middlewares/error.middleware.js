const ApiError = require('../utils/apiError');
const env = require('../config/env');

/* eslint-disable no-unused-vars */
function errorHandler(err, req, res, next) {
  let error = err;

  // Convert known Mongoose errors into ApiError instances
  if (error.name === 'CastError') {
    error = ApiError.badRequest(`Invalid ${error.path}: ${error.value}`);
  }
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue || {})[0];
    error = ApiError.conflict(`${field} already exists`);
  }
  if (error.name === 'ValidationError') {
    const messages = Object.values(error.errors).map((e) => e.message);
    error = ApiError.badRequest('Validation failed', messages);
  }
  if (error.name === 'JsonWebTokenError') {
    error = ApiError.unauthorized('Invalid token');
  }
  if (error.name === 'TokenExpiredError') {
    error = ApiError.unauthorized('Token expired');
  }

  const statusCode = error.statusCode || 500;
  const message = error.message || 'Internal server error';

  if (env.env === 'development' && statusCode === 500) {
    console.error(err);
  }

  res.status(statusCode).json({
    success: false,
    message,
    errors: error.errors || [],
    ...(env.env === 'development' && { stack: err.stack }),
  });
}

function notFound(req, res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

module.exports = { errorHandler, notFound };
