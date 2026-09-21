const { S3Client } = require('@aws-sdk/client-s3');
const env = require('./env');

// R2 speaks the S3 API, so the standard AWS SDK works — just point it at
// R2's endpoint instead of AWS's, using the R2 API token's key/secret.
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${env.cloudflare.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.cloudflare.r2.accessKeyId,
    secretAccessKey: env.cloudflare.r2.secretAccessKey,
  },
});

module.exports = r2Client;