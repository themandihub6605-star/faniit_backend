const ApiError = require('../utils/apiError');

/**
 * Validates req.body against a Zod schema. Usage:
 * router.post('/', validate(registerSchema), controller)
 */
const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const messages = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
    throw ApiError.badRequest('Validation failed', messages);
  }
  req.body = result.data;
  next();
};

module.exports = validate;
