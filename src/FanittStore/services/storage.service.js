const { PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { randomUUID } = require('crypto');
const path = require('path');
const r2Client = require('../../config/r2');
const env = require('../../config/env');
const ApiError = require('../../utils/apiError');
const { LIMITS } = require('../constants');
const log = require('../utils/logger');

// Private file storage for paid product files and KYC documents.
// Uses R2_PRIVATE_BUCKET_NAME when set (recommended: a bucket WITHOUT
// public access), otherwise the main bucket. Files are only ever reached
// through short-lived signed links — never public URLs.

function bucket() {
  const name = env.cloudflare?.r2?.privateBucketName || env.cloudflare?.r2?.bucketName;
  if (!name) throw ApiError.internal('File storage is not configured (R2 bucket missing)');
  return name;
}

function safeFileName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ()]/g, '_');
  return base.slice(-120) || 'file';
}

/** Key layout: store/<area>/<ownerId>/<uuid>-<fileName> */
function buildKey(area, ownerId, fileName) {
  return `store/${area}/${ownerId}/${randomUUID()}-${safeFileName(fileName)}`;
}

/** Signed PUT link so the app uploads big files straight to storage
 * (they never pass through our server). */
async function presignUpload({ key, mimeType, size }) {
  const command = new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: mimeType, ContentLength: size });
  const url = await getSignedUrl(r2Client, command, { expiresIn: LIMITS.UPLOAD_URL_TTL_SECONDS });
  return { url, expiresIn: LIMITS.UPLOAD_URL_TTL_SECONDS };
}

/** Signed GET link. `downloadName` makes the browser/app save it with the
 * original file name. */
async function presignDownload(key, downloadName, { inline = false } = {}) {
  const disposition = `${inline ? 'inline' : 'attachment'}; filename="${safeFileName(downloadName)}"`;
  const command = new GetObjectCommand({ Bucket: bucket(), Key: key, ResponseContentDisposition: disposition });
  const url = await getSignedUrl(r2Client, command, { expiresIn: LIMITS.DOWNLOAD_URL_TTL_SECONDS });
  return { url, expiresIn: LIMITS.DOWNLOAD_URL_TTL_SECONDS };
}

/** Size + type of an uploaded object, or null if it doesn't exist. */
async function head(key) {
  try {
    const res = await r2Client.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: Number(res.ContentLength || 0), mimeType: res.ContentType || '' };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
    log.error('storage.head_failed', err, { key });
    throw ApiError.internal('Could not check the uploaded file — try again');
  }
}

async function putBuffer({ key, buffer, mimeType }) {
  await r2Client.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: buffer, ContentType: mimeType }));
  return key;
}

/** Best-effort delete — a leftover file must never break the user's action. */
async function remove(key) {
  if (!key) return;
  try {
    await r2Client.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (err) {
    log.warn('storage.delete_failed', { key, message: err?.message });
  }
}

module.exports = { buildKey, presignUpload, presignDownload, head, putBuffer, remove, safeFileName };
