const { AccessToken, RoomServiceClient, WebhookReceiver } = require('livekit-server-sdk');
const env = require('../../config/env');
const ApiError = require('../../utils/apiError');
const log = require('../utils/logger');

// Everything that talks to LiveKit. Needs LIVEKIT_URL, LIVEKIT_API_KEY and
// LIVEKIT_API_SECRET in .env (from the LiveKit Cloud project settings).

function config() {
  const { url, apiKey, apiSecret } = env.livekit || {};
  if (!url || !apiKey || !apiSecret) {
    throw ApiError.internal('Live video is not configured on the server (LiveKit keys missing)');
  }
  return { url, apiKey, apiSecret };
}

function isConfigured() {
  const { url, apiKey, apiSecret } = env.livekit || {};
  return Boolean(url && apiKey && apiSecret);
}

/** LiveKit's REST API uses https:// even when clients connect with wss://. */
function httpUrl(url) {
  return url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
}

let roomClient = null;
function rooms() {
  const { url, apiKey, apiSecret } = config();
  if (!roomClient) roomClient = new RoomServiceClient(httpUrl(url), apiKey, apiSecret);
  return roomClient;
}

/**
 * Join token for one person in one room.
 * `canPublish` = can send audio/video (host, or both people in a call).
 * Everyone can send data messages (chat, reactions) unless `canChat` is false.
 */
async function createToken({ roomName, identity, name, canPublish, canChat = true, hidden = false, ttl, metadata }) {
  const { url, apiKey, apiSecret } = config();
  const token = new AccessToken(apiKey, apiSecret, {
    identity: String(identity),
    name: name || 'Fanitt user',
    ttl,
    metadata: metadata ? JSON.stringify(metadata) : undefined,
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: Boolean(canPublish),
    canSubscribe: true,
    canPublishData: Boolean(canChat),
    // Hidden participants (admin watching silently) aren't shown to others.
    hidden: Boolean(hidden),
  });
  return { url, token: await token.toJwt(), roomName };
}

/** Creates the room up front so limits apply (optional — LiveKit also auto-creates). */
async function ensureRoom(roomName, { maxParticipants = 0, emptyTimeout = 10 * 60 } = {}) {
  try {
    await rooms().createRoom({ name: roomName, emptyTimeout, maxParticipants });
  } catch (err) {
    // Not fatal: joining still creates the room.
    log.warn('livekit.create_room_failed', { roomName, message: err?.message });
  }
}

/** Ends a room for everyone. Safe to call on rooms that are already gone. */
async function closeRoom(roomName) {
  if (!isConfigured()) return;
  try {
    await rooms().deleteRoom(roomName);
  } catch (err) {
    log.warn('livekit.delete_room_failed', { roomName, message: err?.message });
  }
}

/** Who is in a room right now. Empty when the room doesn't exist. */
async function listParticipants(roomName) {
  if (!isConfigured()) return [];
  try {
    const people = await rooms().listParticipants(roomName);
    return people.map((p) => {
      let meta = {};
      try {
        meta = p.metadata ? JSON.parse(p.metadata) : {};
      } catch {
        meta = {};
      }
      const tracks = p.tracks || [];
      return {
        identity: p.identity,
        name: p.name || 'Guest',
        role: meta.role || 'guest',
        joinedAt: p.joinedAt ? new Date(Number(p.joinedAt) * 1000) : null,
        hidden: Boolean(p.permission?.hidden),
        // TrackType: 0 = audio, 1 = video
        audioOn: tracks.some((t) => t.type === 0 && !t.muted),
        videoOn: tracks.some((t) => t.type === 1 && !t.muted),
      };
    });
  } catch (err) {
    log.warn('livekit.list_participants_failed', { roomName, message: err?.message });
    return [];
  }
}

/** Removes one person from a room (they can rejoin if still allowed). */
async function removeParticipant(roomName, identity) {
  await rooms().removeParticipant(roomName, String(identity));
}

let receiver = null;
/** Verifies and parses a LiveKit webhook. Throws on a bad signature. */
async function parseWebhook(rawBody, authHeader) {
  const { apiKey, apiSecret } = config();
  if (!receiver) receiver = new WebhookReceiver(apiKey, apiSecret);
  return receiver.receive(rawBody, authHeader);
}

module.exports = { createToken, ensureRoom, closeRoom, listParticipants, removeParticipant, parseWebhook, isConfigured };