const jwt = require('jsonwebtoken');
const { getZoomAccessToken } = require('../config/zoom');
const env = require('../config/env');
const ApiError = require('../utils/apiError');

async function createMeeting({ topic, startTime, durationMinutes, hostEmail }) {
  const accessToken = await getZoomAccessToken();

  const response = await fetch(`https://api.zoom.us/v2/users/${hostEmail}/meetings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topic,
      type: 2,
      start_time: startTime,
      duration: durationMinutes,
      settings: {
        host_video: true,
        participant_video: true,
        join_before_host: false,
        waiting_room: true,
        approval_type: 0,
      },
    }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw ApiError.internal(`Zoom meeting creation failed: ${errBody.message || response.statusText}`);
  }

  const meeting = await response.json();
  return {
    zoomMeetingId: String(meeting.id),
    zoomJoinUrl: meeting.join_url,
    zoomStartUrl: meeting.start_url,
    zoomPassword: meeting.password || '',
  };
}

function generateSdkSignature(meetingNumber, role) {
  const iat = Math.round(Date.now() / 1000) - 30;
  const exp = iat + 60 * 60 * 2;

  const payload = {
    sdkKey: env.zoom.sdkKey,
    mn: meetingNumber,
    role,
    iat,
    exp,
    appKey: env.zoom.sdkKey,
    tokenExp: exp,
  };

  return jwt.sign(payload, env.zoom.sdkSecret, { algorithm: 'HS256', header: { alg: 'HS256', typ: 'JWT' } });
}

module.exports = { createMeeting, generateSdkSignature };