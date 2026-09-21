const multer = require('multer');
const sharp = require('sharp');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID } = require('crypto');
const r2Client = require('../config/r2');
const env = require('../config/env');

const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg', // non-standard but some browsers/OSes send this for .jpg
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic', // iPhone camera default format
  'image/heif',
  'image/avif',
  'image/bmp',
];
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

function extensionFor(mimetype) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt',
  };
  return map[mimetype] || 'bin';
}

/**
 * Resize/optimize an image buffer the same way Cloudinary's upload-time
 * transformation did: cap at 1600x1600, convert to a web-friendly format,
 * strip metadata. GIFs pass through untouched so animation isn't lost.
 */
async function optimizeImage(buffer, mimetype) {
  if (mimetype === 'image/gif') return { buffer, mimetype };
  const optimized = await sharp(buffer)
    .rotate() // respect EXIF orientation before resizing
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  return { buffer: optimized, mimetype: 'image/webp' };
}

async function uploadBufferToR2(buffer, mimetype, folder) {
  const key = `${folder}/${randomUUID()}.${extensionFor(mimetype)}`;
  await r2Client.send(
    new PutObjectCommand({
      Bucket: env.cloudflare.r2.bucketName,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    })
  );
  return `${env.cloudflare.r2.publicUrl}/${key}`;
}

/**
 * Cloudflare Stream's one-shot upload endpoint — takes a video buffer,
 * returns transcoding + playback info. Ingress and encoding are free;
 * you only pay for minutes stored and minutes delivered.
 */
async function uploadBufferToStream(buffer, filename, mimetype) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), filename);

  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.cloudflare.accountId}/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.cloudflare.streamApiToken}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    const message = data?.errors?.[0]?.message || 'Cloudflare Stream upload failed';
    throw new Error(message);
  }
  // .hls is the adaptive-bitrate playback URL — this is what you'd put in
  // a <video> tag / player, same role campaignImageUrl-style fields play
  // for images. .thumbnail is a still frame, handy for post/campaign covers.
  return { playbackUrl: data.result.playback.hls, thumbnailUrl: data.result.thumbnail, uid: data.result.uid };
}

/**
 * Custom multer storage engine — same role multer-storage-cloudinary
 * played before. Routes each file to R2 (images/documents) or Cloudflare
 * Stream (video) based on mimetype, and sets file.path to the final
 * public URL so every existing controller (which reads req.file.path /
 * req.files[].path) keeps working unchanged.
 */
class CloudflareStorage {
  constructor({ folder }) {
    this.folder = folder;
  }

  _handleFile(req, file, cb) {
    const chunks = [];
    file.stream.on('data', (chunk) => chunks.push(chunk));
    file.stream.on('error', (err) => cb(err));
    file.stream.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);

        if (ALLOWED_VIDEO_TYPES.includes(file.mimetype)) {
          const { playbackUrl, thumbnailUrl, uid } = await uploadBufferToStream(buffer, file.originalname, file.mimetype);
          return cb(null, { path: playbackUrl, thumbnailUrl, streamUid: uid, size: buffer.length });
        }

        if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
          const { buffer: optimized, mimetype } = await optimizeImage(buffer, file.mimetype);
          const url = await uploadBufferToR2(optimized, mimetype, this.folder);
          return cb(null, { path: url, size: optimized.length });
        }

        // Documents — store as-is, no image processing.
        const url = await uploadBufferToR2(buffer, file.mimetype, this.folder);
        return cb(null, { path: url, size: buffer.length });
      } catch (err) {
        cb(err);
      }
    });
  }

  // R2 objects are named by random UUID (see uploadBufferToR2), so there's
  // nothing for multer to clean up on its own — deletion, if ever needed,
  // is a deliberate DeleteObjectCommand call elsewhere, not this hook.
  _removeFile(req, file, cb) {
    cb(null);
  }
}

const storage = (folder) => new CloudflareStorage({ folder });

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