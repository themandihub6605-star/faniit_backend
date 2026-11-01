// File: src/FanittStore/services/livekit.service.js
const { AccessToken, RoomServiceClient, WebhookReceiver, DataPacket_Kind } = require('livekit-server-sdk');
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

/**
 * Mutes one person's mic ('audio') or camera ('video'). Returns how many
 * tracks were muted. LiveKit allows a server to mute but not to unmute.
 */
async function muteTracks(roomName, identity, kind = 'audio') {
  const type = kind === 'video' ? 1 : 0; // TrackType: 0 = audio, 1 = video
  let person;
  try {
    person = await rooms().getParticipant(roomName, String(identity));
  } catch {
    return 0; // not in the room any more
  }
  let count = 0;
  for (const t of person?.tracks || []) {
    // Screen share is video too (source 3/4) — leave it alone.
    const isScreen = t.source === 3 || t.source === 4;
    if (t.type === type && !t.muted && !isScreen) {
      // eslint-disable-next-line no-await-in-loop
      await rooms().mutePublishedTrack(roomName, String(identity), t.sid, true);
      count += 1;
    }
  }
  return count;
}

let receiver = null;
/** Verifies and parses a LiveKit webhook. Throws on a bad signature. */
async function parseWebhook(rawBody, authHeader) {
  const { apiKey, apiSecret } = config();
  if (!receiver) receiver = new WebhookReceiver(apiKey, apiSecret);
  return receiver.receive(rawBody, authHeader);
}

/** Sends a JSON data message to everyone in a room (same format the app's
 * chat / hearts use). Never throws. */
async function sendData(roomName, payload) {
  if (!isConfigured()) return false;
  try {
    const data = new TextEncoder().encode(JSON.stringify(payload));
    await rooms().sendData(roomName, data, DataPacket_Kind.RELIABLE, {});
    return true;
  } catch (err) {
    log.warn('livekit.send_data_failed', { roomName, message: err?.message });
    return false;
  }
}

/** One person in a room, or null when they're not there. */
async function getParticipant(roomName, identity) {
  try {
    return await rooms().getParticipant(roomName, String(identity));
  } catch {
    return null;
  }
}

/**
 * Lets a viewer send camera + mic (live "Request to join" accepted), or takes
 * it away again. LiveKit replaces all permissions at once, so every one is set.
 * Taking publish away also stops their camera and mic for everyone.
 */
async function setCanPublish(roomName, identity, canPublish, { canChat = true, role } = {}) {
  const options = {
    permission: { canSubscribe: true, canPublish: Boolean(canPublish), canPublishData: Boolean(canChat) },
  };
  if (role) options.metadata = JSON.stringify({ role });
  return rooms().updateParticipant(roomName, String(identity), options);
}

module.exports = {
  createToken,
  ensureRoom,
  closeRoom,
  listParticipants,
  removeParticipant,
  muteTracks,
  parseWebhook,
  isConfigured,
  sendData,
  getParticipant,
  setCanPublish,
};