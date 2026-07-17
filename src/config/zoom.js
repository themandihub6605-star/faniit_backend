const env = require('./env');

let cachedToken = null;
let cachedTokenExpiry = 0;

/**
 * Fetches (and caches) a Server-to-Server OAuth access token from Zoom.
 * Used by zoom.service.js to create/manage meetings via the Zoom REST API.
 */
async function getZoomAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  const basicAuth = Buffer.from(`${env.zoom.clientId}:${env.zoom.clientSecret}`).toString('base64');

  const response = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${env.zoom.accountId}`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${basicAuth}` },
    }
  );

  if (!response.ok) {
    throw new Error('Failed to fetch Zoom access token');
  }

  const data = await response.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // refresh 1 min early
  return cachedToken;
}

module.exports = { getZoomAccessToken };
