const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids visual mix-ups when someone reads a code aloud or types it in

/** A random 6-character referral code (e.g. "K7F3QX"). Caller is
 * responsible for checking it against the relevant collection for
 * uniqueness and re-rolling on a collision — this function just
 * generates one candidate. */
function generateReferralCode() {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

module.exports = generateReferralCode;