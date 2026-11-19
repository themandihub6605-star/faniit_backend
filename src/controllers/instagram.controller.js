// File: src/controllers/instagram.controller.js
const crypto = require('crypto');
const axios = require('axios');
const InstagramAccount = require('../models/InstagramAccount.model');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');

// Instagram connect (Instagram API with Instagram Login) + Auto DM.
// Used by fanitt.com/connect/instagram.
//
//   GET    /instagram/auth-url          Instagram login link for the logged-in user
//   POST   /instagram/connect           { code, state }  finish the login
//   GET    /instagram/me                connected account + rules + Auto DM log
//   POST   /instagram/refresh           reload profile numbers (followers, posts)
//   GET    /instagram/media             latest posts / reels
//   POST   /instagram/rules             { mediaId, keyword, dmText, replyText? }
//   PATCH  /instagram/rules/:ruleId     { active }
//   DELETE /instagram/rules/:ruleId
//   DELETE /instagram/connect           disconnect
//   GET    /instagram/webhook           Meta verification
//   POST   /instagram/webhook           comments → Auto DM
//
// .env: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, INSTAGRAM_VERIFY_TOKEN,
//       optional INSTAGRAM_REDIRECT_URI (default https://fanitt.com/connect/instagram),
//       optional INSTAGRAM_GRAPH_VERSION (default v24.0)

const GRAPH = () => `https://graph.instagram.com/${process.env.INSTAGRAM_GRAPH_VERSION || 'v24.0'}`;
const REDIRECT_URI = () => process.env.INSTAGRAM_REDIRECT_URI || 'https://fanitt.com/connect/instagram';
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_manage_messages'];
const PROFILE_FIELDS = 'user_id,username,name,profile_picture_url,followers_count,follows_count,media_count';

function igError(err, fallback) {
  const e = err?.response?.data?.error;
  return e?.error_user_msg || e?.message || err?.response?.data?.error_message || err?.message || fallback;
}

function requireConfig() {
  if (!process.env.INSTAGRAM_APP_ID || !process.env.INSTAGRAM_APP_SECRET) {
    throw new ApiError(503, 'Instagram connect is not set up on the server yet');
  }
}

// state = "<time>.<signature>" tied to the logged-in user (stops forged logins).
function makeState(userId) {
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', process.env.INSTAGRAM_APP_SECRET).update(`${userId}.${ts}`).digest('hex').slice(0, 32);
  return `${ts}.${sig}`;
}
function checkState(userId, state) {
  const [ts, sig] = String(state || '').split('.');
  if (!ts || !sig) return false;
  if (Date.now() - Number(ts) > 30 * 60 * 1000) return false;
  const good = crypto.createHmac('sha256', process.env.INSTAGRAM_APP_SECRET).update(`${userId}.${ts}`).digest('hex').slice(0, 32);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

/** Long-lived tokens last 60 days; refresh when fewer than 10 days are left. */
async function freshToken(acc) {
  const left = acc.tokenExpiresAt ? acc.tokenExpiresAt.getTime() - Date.now() : 0;
  if (left > 10 * 24 * 3600 * 1000) return acc.accessToken;
  try {
    const { data } = await axios.get('https://graph.instagram.com/refresh_access_token', {
      params: { grant_type: 'ig_refresh_token', access_token: acc.accessToken },
      timeout: 15000,
    });
    if (data?.access_token) {
      acc.accessToken = data.access_token;
      acc.tokenExpiresAt = new Date(Date.now() + (data.expires_in || 5184000) * 1000);
      await acc.save();
    }
  } catch (err) {
    acc.lastError = `Token refresh: ${igError(err, 'failed')}`;
    await acc.save();
  }
  return acc.accessToken;
}

async function loadAccount(userId) {
  const acc = await InstagramAccount.findOne({ user: userId, status: 'connected' }).select('+accessToken');
  if (!acc) throw ApiError.notFound('No Instagram account connected yet');
  return acc;
}

async function fetchProfile(token) {
  const { data } = await axios.get(`${GRAPH()}/me`, { params: { fields: PROFILE_FIELDS, access_token: token }, timeout: 15000 });
  return data;
}

function applyProfile(acc, p) {
  acc.username = p.username || acc.username;
  acc.name = p.name || '';
  acc.profilePictureUrl = p.profile_picture_url || '';
  acc.followersCount = p.followers_count || 0;
  acc.followsCount = p.follows_count || 0;
  acc.mediaCount = p.media_count || 0;
}

// GET /instagram/auth-url
const authUrl = catchAsync(async (req, res) => {
  requireConfig();
  const params = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID,
    redirect_uri: REDIRECT_URI(),
    response_type: 'code',
    scope: SCOPES.join(','),
    state: makeState(String(req.user._id)),
  });
  return new ApiResponse(200, { url: `https://www.instagram.com/oauth/authorize?${params}` }).send(res);
});

// POST /instagram/connect
const connect = catchAsync(async (req, res) => {
  requireConfig();
  const code = String(req.body?.code || '').replace(/#_$/, '');
  if (!code) throw ApiError.badRequest('Missing Instagram code');
  if (!checkState(String(req.user._id), req.body?.state)) throw ApiError.badRequest('This Instagram login link expired. Please click Connect Instagram again.');

  // 1. Code → short-lived token.
  let shortToken;
  try {
    const form = new URLSearchParams({
      client_id: process.env.INSTAGRAM_APP_ID,
      client_secret: process.env.INSTAGRAM_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI(),
      code,
    });
    const { data } = await axios.post('https://api.instagram.com/oauth/access_token', form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    shortToken = data.access_token;
  } catch (err) {
    throw ApiError.badRequest(`Instagram didn't accept the login: ${igError(err, 'token exchange failed')}`);
  }

  // 2. Short → long-lived token (60 days).
  let token = shortToken;
  let expiresIn = 3600;
  try {
    const { data } = await axios.get('https://graph.instagram.com/access_token', {
      params: { grant_type: 'ig_exchange_token', client_secret: process.env.INSTAGRAM_APP_SECRET, access_token: shortToken },
      timeout: 15000,
    });
    token = data.access_token;
    expiresIn = data.expires_in || 5184000;
  } catch (err) {
    throw ApiError.badRequest(`Instagram token error: ${igError(err, 'exchange failed')}`);
  }

  // 3. Profile.
  let profile;
  try {
    profile = await fetchProfile(token);
  } catch (err) {
    throw ApiError.badRequest(`Couldn't read the Instagram profile: ${igError(err, 'failed')}`);
  }
  const igUserId = String(profile.user_id || profile.id);

  // 4. Comment + message webhooks for this account (needed for Auto DM).
  let lastError = '';
  try {
    await axios.post(`${GRAPH()}/me/subscribed_apps`, null, {
      params: { subscribed_fields: 'comments,messages', access_token: token },
      timeout: 15000,
    });
  } catch (err) {
    lastError = `Webhook subscribe: ${igError(err, 'failed')}`;
  }

  // The same Instagram account can be linked to only one Fanitt user.
  await InstagramAccount.deleteMany({ igUserId, user: { $ne: req.user._id } });

  let acc = await InstagramAccount.findOne({ user: req.user._id }).select('+accessToken');
  if (acc && acc.igUserId !== igUserId) acc.rules = []; // different account → old rules don't apply
  if (!acc) acc = new InstagramAccount({ user: req.user._id, igUserId, accessToken: token });
  acc.igUserId = igUserId;
  acc.accessToken = token;
  acc.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
  acc.status = 'connected';
  acc.lastError = lastError;
  applyProfile(acc, profile);
  await acc.save();

  return new ApiResponse(200, acc.toPublic(), 'Instagram connected').send(res);
});

// GET /instagram/me
const me = catchAsync(async (req, res) => {
  const acc = await InstagramAccount.findOne({ user: req.user._id, status: 'connected' });
  return new ApiResponse(200, acc ? acc.toPublic() : null).send(res);
});

// POST /instagram/refresh
const refresh = catchAsync(async (req, res) => {
  const acc = await loadAccount(req.user._id);
  const token = await freshToken(acc);
  try {
    applyProfile(acc, await fetchProfile(token));
    acc.lastError = '';
  } catch (err) {
    acc.lastError = `Profile: ${igError(err, 'failed')}`;
  }
  await acc.save();
  return new ApiResponse(200, acc.toPublic()).send(res);
});

// GET /instagram/media
const media = catchAsync(async (req, res) => {
  const acc = await loadAccount(req.user._id);
  const token = await freshToken(acc);
  try {
    const { data } = await axios.get(`${GRAPH()}/me/media`, {
      params: {
        fields: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
        limit: 24,
        access_token: token,
      },
      timeout: 15000,
    });
    const list = (data?.data || []).map((m) => ({
      id: m.id,
      caption: (m.caption || '').slice(0, 200),
      type: m.media_product_type === 'REELS' ? 'REEL' : m.media_type,
      thumb: m.thumbnail_url || (m.media_type === 'VIDEO' ? '' : m.media_url) || '',
      permalink: m.permalink,
      timestamp: m.timestamp,
      likes: m.like_count || 0,
      comments: m.comments_count || 0,
    }));
    return new ApiResponse(200, list).send(res);
  } catch (err) {
    throw ApiError.badRequest(`Couldn't load posts: ${igError(err, 'failed')}`);
  }
});

// POST /instagram/rules
const createRule = catchAsync(async (req, res) => {
  const acc = await loadAccount(req.user._id);
  const keyword = String(req.body?.keyword || '').trim().slice(0, 50);
  const dmText = String(req.body?.dmText || '').trim().slice(0, 1000);
  const replyText = String(req.body?.replyText || '').trim().slice(0, 300);
  const mediaId = String(req.body?.mediaId || 'any').trim() || 'any';
  if (!keyword) throw ApiError.badRequest('Keyword is required');
  if (!dmText) throw ApiError.badRequest('DM message is required');
  if (acc.rules.length >= 50) throw ApiError.badRequest('You can have up to 50 Auto DM rules');

  acc.rules.push({
    mediaId,
    mediaCaption: String(req.body?.mediaCaption || '').slice(0, 120),
    mediaThumb: String(req.body?.mediaThumb || '').slice(0, 2000),
    mediaPermalink: String(req.body?.mediaPermalink || '').slice(0, 500),
    keyword,
    dmText,
    replyText,
  });
  await acc.save();
  return new ApiResponse(201, acc.toPublic(), 'Auto DM rule saved').send(res);
});

// PATCH /instagram/rules/:ruleId
const updateRule = catchAsync(async (req, res) => {
  const acc = await loadAccount(req.user._id);
  const rule = acc.rules.id(req.params.ruleId);
  if (!rule) throw ApiError.notFound('Rule not found');
  if (typeof req.body?.active === 'boolean') rule.active = req.body.active;
  await acc.save();
  return new ApiResponse(200, acc.toPublic()).send(res);
});

// DELETE /instagram/rules/:ruleId
const deleteRule = catchAsync(async (req, res) => {
  const acc = await loadAccount(req.user._id);
  acc.rules = acc.rules.filter((r) => String(r._id) !== req.params.ruleId);
  await acc.save();
  return new ApiResponse(200, acc.toPublic(), 'Rule deleted').send(res);
});

// DELETE /instagram/connect
const disconnect = catchAsync(async (req, res) => {
  await InstagramAccount.deleteOne({ user: req.user._id });
  return new ApiResponse(200, null, 'Instagram disconnected').send(res);
});

// ---------- Webhook ----------

// GET /instagram/webhook — Meta verification (read the raw URL: sanitizers strip "hub.*").
const verifyWebhook = (req, res) => {
  const params = new URL(req.originalUrl, 'http://localhost').searchParams;
  if (params.get('hub.mode') === 'subscribe' && params.get('hub.verify_token') === process.env.INSTAGRAM_VERIFY_TOKEN) {
    return res.status(200).send(params.get('hub.challenge'));
  }
  return res.sendStatus(403);
};

function validSignature(req) {
  const secret = process.env.INSTAGRAM_APP_SECRET;
  const header = req.get('x-hub-signature-256') || '';
  if (!secret || !req.rawBody || !header.startsWith('sha256=')) return false;
  const good = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const got = header.slice(7);
  return got.length === good.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(good));
}

function matches(text, keyword) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const k = String(keyword || '').toLowerCase().trim();
  if (!k) return false;
  // whole word / phrase, so "link" matches "Link please" but not "linking"
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'u').test(t);
}

async function handleComment(igUserId, value) {
  const commentId = value?.id;
  const mediaId = value?.media?.id;
  const fromId = value?.from?.id;
  if (!commentId || !mediaId) return;
  if (fromId && String(fromId) === String(igUserId)) return; // the creator's own comment

  const acc = await InstagramAccount.findOne({ igUserId: String(igUserId), status: 'connected' }).select('+accessToken +handledCommentIds');
  if (!acc) return;
  if (acc.handledCommentIds.includes(commentId)) return;

  const rule =
    acc.rules.find((r) => r.active && r.mediaId === mediaId && matches(value.text, r.keyword)) ||
    acc.rules.find((r) => r.active && r.mediaId === 'any' && matches(value.text, r.keyword));
  if (!rule) return;

  acc.handledCommentIds.push(commentId);
  if (acc.handledCommentIds.length > 1000) acc.handledCommentIds = acc.handledCommentIds.slice(-1000);

  const token = await freshToken(acc);
  const line = {
    commentId,
    fromUsername: value?.from?.username || '',
    commentText: String(value.text || '').slice(0, 300),
    mediaId,
    keyword: rule.keyword,
  };

  // Private reply = a DM to the person who commented (one per comment, within 7 days).
  try {
    await axios.post(
      `${GRAPH()}/${acc.igUserId}/messages`,
      { recipient: { comment_id: commentId }, message: { text: rule.dmText } },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 },
    );
    line.dmStatus = 'sent';
    rule.sentCount += 1;
  } catch (err) {
    line.dmStatus = 'failed';
    line.error = igError(err, 'DM failed');
  }

  if (rule.replyText) {
    try {
      await axios.post(`${GRAPH()}/${commentId}/replies`, null, {
        params: { message: rule.replyText, access_token: token },
        timeout: 15000,
      });
      line.replyStatus = 'sent';
    } catch (err) {
      line.replyStatus = 'failed';
      line.error = line.error || igError(err, 'Reply failed');
    }
  }

  acc.addLog(line);
  await acc.save();
}

// POST /instagram/webhook
const receiveWebhook = async (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200); // answer fast, work after

  try {
    const body = req.body || {};
    if (body.object !== 'instagram') return;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'comments') await handleComment(entry.id, change.value);
      }
    }
  } catch (err) {
    console.error('[Instagram] webhook processing error:', err);
  }
};

module.exports = {
  authUrl,
  connect,
  me,
  refresh,
  media,
  createRule,
  updateRule,
  deleteRule,
  disconnect,
  verifyWebhook,
  receiveWebhook,
};