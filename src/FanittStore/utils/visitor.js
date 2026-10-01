const crypto = require('crypto');

/** Stable key for "one visitor": the user id, or a hash of IP + device. */
function visitorKey(req) {
  if (req.user?._id) return `u:${req.user._id}`;
  const raw = `${req.ip || ''}|${req.get('user-agent') || ''}`;
  return `a:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

module.exports = { visitorKey };
