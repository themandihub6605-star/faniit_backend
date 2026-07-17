const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];

const storage = (folder) =>
  new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => ({
      folder,
      resource_type: ALLOWED_VIDEO_TYPES.includes(file.mimetype) ? 'video' : 'image',
      transformation: ALLOWED_VIDEO_TYPES.includes(file.mimetype)
        ? [{ quality: 'auto', fetch_format: 'auto' }]
        : [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
    }),
  });

const fileFilter = (req, file, cb) => {
  const allowed = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type'), false);
  }
};

const uploadImage = (folder) =>
  multer({
    storage: storage(folder),
    fileFilter: (req, file, cb) => {
      if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) cb(null, true);
      else cb(new Error('Only image files are allowed'), false);
    },
    limits: { fileSize: 10 * 1024 * 1024 },
  });

const uploadMedia = (folder) =>
  multer({
    storage: storage(folder),
    fileFilter,
    limits: { fileSize: 100 * 1024 * 1024 },
  });

module.exports = { uploadImage, uploadMedia };