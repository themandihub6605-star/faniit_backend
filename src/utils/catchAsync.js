/**
 * Wraps an async controller/middleware function so any thrown error or
 * rejected promise is automatically forwarded to Express's error handler,
 * instead of every controller needing its own try/catch block.
 */
const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = catchAsync;
