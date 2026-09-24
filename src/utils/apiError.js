class ApiError extends Error {
  constructor(statusCode, message = 'Something went wrong', errors = [], errorCode = null) {
    super(message);
    this.statusCode = statusCode;
    this.success = false;
    this.errors = Array.isArray(errors) ? errors : [];
    // Stable, machine-readable code for cases where the frontend needs to
    // branch on *which* error this is (e.g. 'PROPOSAL_QUOTA_EXCEEDED' to
    // open the upgrade modal) instead of matching on the message text.
    // Always a string or null — never an array.
    this.errorCode = typeof errorCode === 'string' && errorCode ? errorCode : null;
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Accepts both call styles used across the codebase:
   *   ApiError.forbidden(message, 'CODE')
   *   ApiError.forbidden(message, [], 'CODE')
   * The second style previously put [] into errorCode, which sent
   * `errorCode: []` to clients.
   */
  static _resolve(errorsOrCode, maybeCode) {
    if (typeof errorsOrCode === 'string') return { errors: [], errorCode: errorsOrCode };
    return { errors: Array.isArray(errorsOrCode) ? errorsOrCode : [], errorCode: maybeCode ?? null };
  }

  static badRequest(message, errorsOrCode = [], maybeCode = null) {
    const { errors, errorCode } = ApiError._resolve(errorsOrCode, maybeCode);
    return new ApiError(400, message, errors, errorCode);
  }
  static unauthorized(message = 'Unauthorized') {
    return new ApiError(401, message);
  }
  static forbidden(message = 'Forbidden', errorsOrCode = null, maybeCode = null) {
    const { errors, errorCode } = ApiError._resolve(errorsOrCode, maybeCode);
    return new ApiError(403, message, errors, errorCode);
  }
  static notFound(message = 'Resource not found') {
    return new ApiError(404, message);
  }
  static conflict(message = 'Conflict', errorsOrCode = null, maybeCode = null) {
    const { errors, errorCode } = ApiError._resolve(errorsOrCode, maybeCode);
    return new ApiError(409, message, errors, errorCode);
  }
  static internal(message = 'Internal server error') {
    return new ApiError(500, message);
  }
}

module.exports = ApiError;