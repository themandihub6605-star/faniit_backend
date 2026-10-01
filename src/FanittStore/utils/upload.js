const multer = require('multer');
const ApiError = require('../../utils/apiError');
const { LIMITS } = require('../constants');

// KYC documents are read into memory (small, max 8 MB) and then written to
// PRIVATE storage by the controller — never to the public media bucket.
const KYC_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];

const kycUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITS.KYC_DOC_MAX_BYTES, files: 2 },
  fileFilter: (req, file, cb) => {
    if (KYC_TYPES.includes(file.mimetype)) return cb(null, true);
    return cb(ApiError.badRequest('KYC documents must be a photo (JPG/PNG/WEBP/HEIC) or a PDF'));
  },
}).fields([
  { name: 'panDocument', maxCount: 1 },
  { name: 'idDocument', maxCount: 1 },
]);

/** Wraps multer so its errors come back as normal ApiErrors. */
function handleUpload(middleware) {
  return (req, res, next) =>
    middleware(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        const message = err.code === 'LIMIT_FILE_SIZE' ? `Each document can be up to ${LIMITS.KYC_DOC_MAX_BYTES / (1024 * 1024)} MB` : err.message;
        return next(ApiError.badRequest(message));
      }
      return next(err);
    });
}

module.exports = { kycUpload: handleUpload(kycUpload), handleUpload };
