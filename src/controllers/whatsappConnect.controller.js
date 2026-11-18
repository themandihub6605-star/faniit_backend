// File: src/controllers/whatsappConnect.controller.js
const crypto = require('crypto');
const axios = require('axios');
const WhatsAppAccount = require('../models/WhatsAppAccount.model');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');

// Connect a WhatsApp Business number with Meta's Embedded Signup and send
// messages from it. Used by fanitt.com/connect/whatsapp.
//
//   POST   /whatsapp/connect            { code, wabaId, phoneNumberId }
//   GET    /whatsapp/connect/me         connected number + recent messages
//   POST   /whatsapp/connect/send       { to, text? }  (no text → hello_world template)
//   GET    /whatsapp/connect/templates  message templates of the account
//   POST   /whatsapp/connect/templates  { name, category, language, body }  create a template
//   DELETE /whatsapp/connect            disconnect
//
// .env: META_APP_ID, META_APP_SECRET, optional META_GRAPH_VERSION (default v24.0)

const GRAPH = () => `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v24.0'}`;

/** Readable message out of a Graph API error. */
function metaError(err, fallback) {
  const e = err?.response?.data?.error;
  return e?.error_user_msg || e?.message || err?.message || fallback;
}

function digits(v) {
  return String(v || '').replace(/\D/g, '');
}

async function loadAccount(userId) {
  const acc = await WhatsAppAccount.findOne({ user: userId, status: 'connected' }).select('+accessToken');
  if (!acc) throw ApiError.notFound('No WhatsApp number connected yet');
  return acc;
}

// POST /whatsapp/connect
const connect = catchAsync(async (req, res) => {
  const { code, wabaId, phoneNumberId } = req.body || {};
  if (!code || !wabaId || !phoneNumberId) throw ApiError.badRequest('code, wabaId and phoneNumberId are required');
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    throw new ApiError(503, 'WhatsApp connect is not set up on the server yet');
  }

  // 1. Code → business access token.
  let accessToken;
  try {
    const { data } = await axios.get(`${GRAPH()}/oauth/access_token`, {
      params: { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, code },
      timeout: 15000,
    });
    accessToken = data.access_token;
  } catch (err) {
    throw ApiError.badRequest(`Meta didn't accept the connection: ${metaError(err, 'token exchange failed')}`);
  }
  if (!accessToken) throw ApiError.badRequest('Meta did not return an access token');

  const auth = { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 };
  let lastError = '';

  // 2. Send this account's webhooks (replies, delivery status) to Fanitt.
  try {
    await axios.post(`${GRAPH()}/${wabaId}/subscribed_apps`, {}, auth);
  } catch (err) {
    lastError = `Webhook subscribe: ${metaError(err, 'failed')}`;
  }

  // 3. Register the number for the Cloud API (already registered / test numbers can fail — fine).
  try {
    const pin = String(crypto.randomInt(100000, 1000000));
    await axios.post(`${GRAPH()}/${phoneNumberId}/register`, { messaging_product: 'whatsapp', pin }, auth);
  } catch (err) {
    const msg = metaError(err, '');
    if (msg && !/already|registered/i.test(msg)) lastError = lastError || `Register: ${msg}`;
  }

  // 4. Number details.
  let displayPhoneNumber = '';
  let verifiedName = '';
  try {
    const { data } = await axios.get(`${GRAPH()}/${phoneNumberId}`, {
      ...auth,
      params: { fields: 'display_phone_number,verified_name' },
    });
    displayPhoneNumber = data.display_phone_number || '';
    verifiedName = data.verified_name || '';
  } catch (err) {
    lastError = lastError || `Number details: ${metaError(err, 'failed')}`;
  }

  const acc = await WhatsAppAccount.findOneAndUpdate(
    { user: req.user._id },
    {
      wabaId: String(wabaId),
      phoneNumberId: String(phoneNumberId),
      displayPhoneNumber,
      verifiedName,
      accessToken,
      status: 'connected',
      lastError,
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  return new ApiResponse(200, acc.toPublic(), 'WhatsApp connected').send(res);
});

// GET /whatsapp/connect/me
const me = catchAsync(async (req, res) => {
  const acc = await WhatsAppAccount.findOne({ user: req.user._id, status: 'connected' });
  return new ApiResponse(200, acc ? acc.toPublic() : null).send(res);
});

// POST /whatsapp/connect/send
const send = catchAsync(async (req, res) => {
  const to = digits(req.body?.to);
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (to.length < 10 || to.length > 15) throw ApiError.badRequest('Enter the number with country code, e.g. 919876543210');

  const acc = await loadAccount(req.user._id);

  // Plain text only reaches people who messaged this number in the last 24 h.
  // Otherwise WhatsApp needs an approved template — hello_world is ready on every account.
  const payload = text
    ? { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }
    : { messaging_product: 'whatsapp', to, type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } };

  let waMessageId = '';
  try {
    const { data } = await axios.post(`${GRAPH()}/${acc.phoneNumberId}/messages`, payload, {
      headers: { Authorization: `Bearer ${acc.accessToken}` },
      timeout: 15000,
    });
    waMessageId = data?.messages?.[0]?.id || '';
  } catch (err) {
    throw ApiError.badRequest(`WhatsApp didn't send it: ${metaError(err, 'send failed')}`);
  }

  acc.addMessage({ direction: 'out', waMessageId, peer: to, kind: text ? 'text' : 'template', text: text || 'hello_world (template)', status: 'sent' });
  await acc.save();

  return new ApiResponse(200, acc.toPublic(), 'Message sent').send(res);
});

// GET /whatsapp/connect/templates
const templates = catchAsync(async (req, res) => {
  const acc = await loadAccount(req.user._id);
  try {
    const { data } = await axios.get(`${GRAPH()}/${acc.wabaId}/message_templates`, {
      headers: { Authorization: `Bearer ${acc.accessToken}` },
      params: { fields: 'name,status,language,category', limit: 50 },
      timeout: 15000,
    });
    const list = (data?.data || []).map((t) => ({ name: t.name, status: t.status, language: t.language, category: t.category }));
    return new ApiResponse(200, list).send(res);
  } catch (err) {
    throw ApiError.badRequest(`Couldn't load templates: ${metaError(err, 'failed')}`);
  }
});

// POST /whatsapp/connect/templates — create a message template (Meta reviews it).
const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING'];
const createTemplate = catchAsync(async (req, res) => {
  const name = String(req.body?.name || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 512);
  const category = String(req.body?.category || 'UTILITY').toUpperCase();
  const language = String(req.body?.language || 'en_US').trim();
  const body = String(req.body?.body || '').trim().slice(0, 1024);
  if (!name) throw ApiError.badRequest('Template name is required (small letters, numbers and _)');
  if (!TEMPLATE_CATEGORIES.includes(category)) throw ApiError.badRequest('Category must be UTILITY or MARKETING');
  if (!body) throw ApiError.badRequest('Template text is required');
  if (/\{\{\s*\d+\s*\}\}/.test(body)) throw ApiError.badRequest('Variables like {{1}} are not supported here yet — use plain text');

  const acc = await loadAccount(req.user._id);
  try {
    const { data } = await axios.post(
      `${GRAPH()}/${acc.wabaId}/message_templates`,
      { name, category, language, components: [{ type: 'BODY', text: body }] },
      { headers: { Authorization: `Bearer ${acc.accessToken}` }, timeout: 15000 },
    );
    return new ApiResponse(201, { id: data?.id, name, category, language, status: data?.status || 'PENDING' }, 'Template sent to Meta for review').send(res);
  } catch (err) {
    throw ApiError.badRequest(`Meta didn't accept the template: ${metaError(err, 'create failed')}`);
  }
});

// DELETE /whatsapp/connect
const disconnect = catchAsync(async (req, res) => {
  await WhatsAppAccount.deleteOne({ user: req.user._id });
  return new ApiResponse(200, null, 'WhatsApp disconnected').send(res);
});

module.exports = { connect, me, send, templates, createTemplate, disconnect };