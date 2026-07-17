const ApiError = require('../utils/apiError');

/**
 * Restricts a route to specific roles. Must run after `protect`.
 * Usage: router.post('/campaigns', protect, authorize('brand'), createCampaign)
 */
const authorize = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    throw ApiError.unauthorized('You must be logged in');
  }
  if (!allowedRoles.includes(req.user.role)) {
    throw ApiError.forbidden(`This action requires one of these roles: ${allowedRoles.join(', ')}`);
  }
  next();
};

module.exports = { authorize };
