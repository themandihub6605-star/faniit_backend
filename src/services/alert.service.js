const { User } = require('../models');
const { notify } = require('./notification.service');
const { sendNoticeEmail } = require('./email.service');

// One call for "tell this user": in-app notification + push, and
// optionally an email. Never throws — an alert failing must never break
// the admin action or payment it is attached to.
//
//   alertUser({
//     userId, type, title, message, relatedModel, relatedId, fromUser,
//     email: true | false | { subject, heading, body, reason, reasonLabel, ctaUrl, ctaLabel, tone, to, name },
//     inApp: true,
//   })
//
// email: true → email uses the same title/message.

const SITE = 'https://fanitt.com';

async function sendTheEmail(userId, { title, message }, email) {
  const opts = email === true ? {} : email;
  let { to, name } = opts;
  if (!to) {
    const user = await User.findById(userId).select('name email');
    to = user?.email;
    name = name || user?.name;
  }
  // Deleted accounts get a placeholder address — nothing to send to.
  if (!to || to.endsWith('.invalid')) return;

  await sendNoticeEmail({
    to,
    name,
    subject: opts.subject || title,
    heading: opts.heading || title,
    message: opts.body || message,
    reason: opts.reason,
    reasonLabel: opts.reasonLabel,
    ctaUrl: opts.ctaUrl === undefined ? SITE : opts.ctaUrl,
    ctaLabel: opts.ctaLabel || 'Open Fanitt',
    tone: opts.tone || 'info',
  });
}

async function alertUser({ userId, fromUser = null, type = 'general', title, message, relatedModel = null, relatedId = null, email = false, inApp = true }) {
  if (!userId || !title || !message) return;
  const jobs = [];

  if (inApp) {
    jobs.push(
      notify({ userId, fromUser, type, title, message, relatedModel, relatedId }).catch((err) =>
        console.error('[alert] in-app notification failed:', { type, userId: String(userId), error: err.message })
      )
    );
  }
  if (email) {
    jobs.push(
      sendTheEmail(userId, { title, message }, email).catch((err) =>
        console.error('[alert] email failed:', { type, userId: String(userId), error: err.message })
      )
    );
  }
  await Promise.all(jobs);
}

module.exports = { alertUser };