const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
// Milestone submissions / change requests / dispute evidence — documents in
// addition to whatever images/videos are attached, so a creator can hand
// over a script/brief PDF or a design file alongside their sample media.
const ALLOWED_DOCUMENT_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
];

const storage = (folder) =>
  new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => ({
      folder,
      resource_type: ALLOWED_VIDEO_TYPES.includes(file.mimetype)
        ? 'video'
        : ALLOWED_DOCUMENT_TYPES.includes(file.mimetype)
        ? 'raw'
        : 'image',
      transformation: ALLOWED_VIDEO_TYPES.includes(file.mimetype)
        ? [{ quality: 'auto', fetch_format: 'auto' }]
        : ALLOWED_DOCUMENT_TYPES.includes(file.mimetype)
        ? undefined
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

const attachmentFileFilter = (req, file, cb) => {
  const allowed = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_DOCUMENT_TYPES];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type — images and common document formats only'), false);
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

// Milestone submission / change-request / dispute-evidence attachments —
// images + common document formats, up to 5 files at a time, 20MB each.
const uploadAttachments = (folder) =>
  multer({
    storage: storage(folder),
    fileFilter: attachmentFileFilter,
    limits: { fileSize: 20 * 1024 * 1024 },
  });

module.exports = { uploadImage, uploadMedia, uploadAttachments };