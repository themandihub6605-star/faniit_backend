class ApiError extends Error {
  constructor(statusCode, message = 'Something went wrong', errors = [], errorCode = null) {
    super(message);
    this.statusCode = statusCode;
    this.success = false;
    this.errors = errors;
    // Stable, machine-readable code for cases where the frontend needs to
    // branch on *which* error this is (e.g. 'PROPOSAL_QUOTA_EXCEEDED' to
    // open the upgrade modal) instead of matching on the message text,
    // which breaks the moment the message copy changes. null for
    // ordinary errors that don't need special frontend handling.
    this.errorCode = errorCode;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, errors = [], errorCode = null) {
    return new ApiError(400, message, errors, errorCode);
  }
  static unauthorized(message = 'Unauthorized') {
    return new ApiError(401, message);
  }
  static forbidden(message = 'Forbidden', errorCode = null) {
    return new ApiError(403, message, [], errorCode);
  }
  static notFound(message = 'Resource not found') {
    return new ApiError(404, message);
  }
  static conflict(message = 'Conflict', errorCode = null) {
    return new ApiError(409, message, [], errorCode);
  }
  static internal(message = 'Internal server error') {
    return new ApiError(500, message);
  }
}

module.exports = ApiError;