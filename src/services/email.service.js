const nodemailer = require('nodemailer');

// ZeptoMail SMTP — credentials come from .env, never hardcoded here.
// Required in .env:
//   ZEPTOMAIL_HOST=smtp.zeptomail.in
//   ZEPTOMAIL_PORT=587
//   ZEPTOMAIL_USER=emailapikey
//   ZEPTOMAIL_PASSWORD=<the token from ZeptoMail's SMTP/API tab>
const transporter = nodemailer.createTransport({
  host: process.env.ZEPTOMAIL_HOST,
  port: Number(process.env.ZEPTOMAIL_PORT || 587),
  secure: false, // false for port 587 (STARTTLS) — use true only if switching to port 465
  auth: {
    user: process.env.ZEPTOMAIL_USER,
    pass: process.env.ZEPTOMAIL_PASSWORD,
  },
});

const FROM_ADDRESS = 'support@fanitt.com';
const FROM_NAME = 'Fanitt';

function formatRupees(paise) {
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}

// Shared visual shell every email below plugs its content into — keeps
// every email looking consistent without repeating the same wrapper
// markup in every send function.
function wrapEmail(bodyHtml) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      ${bodyHtml}
      <p style="margin-top: 32px; font-size: 12px; color: #888;">— Team Fanitt</p>
    </div>
  `;
}

function ctaButton(href, label) {
  return `<a href="${href}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #F9436E; color: #fff; text-decoration: none; border-radius: 24px; font-weight: bold;">${label}</a>`;
}

/** Low-level sender — every other function in this file goes through this
 * one. Failures are logged but NEVER thrown further up — a broken email
 * send should never crash or block the actual action it's attached to
 * (e.g. an admin approving a creator must succeed even if the
 * notification email fails to send). */
async function sendEmail({ to, subject, html, text }) {
  if (!to) return; // no address to send to — silently skip rather than error
  try {
    await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_ADDRESS}>`,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, ''), // plain-text fallback for clients that don't render HTML
    });
  } catch (err) {
    console.error('[email.service] Failed to send email:', { to, subject, error: err.message });
  }
}

// ---------- Account approval ----------

async function sendAccountApprovedEmail({ to, name, role }) {
  const roleLabel = role === 'brand' ? 'brand' : role === 'agency' ? 'agency' : 'creator';
  const dashboardPath = role === 'agency' ? '/dashboard/agency' : role === 'brand' ? '/dashboard/brand' : '/dashboard/creator';

  await sendEmail({
    to,
    subject: 'Your Fanitt profile has been approved! 🎉',
    html: wrapEmail(`
      <h2 style="color: #F9436E;">You're approved, ${name}!</h2>
      <p>Great news — your ${roleLabel} profile on Fanitt has been reviewed and approved by our team.</p>
      <p>Your dashboard is now fully unlocked. You can log in and start right away.</p>
      ${ctaButton(`https://fanitt.com${dashboardPath}`, 'Go to my dashboard')}
    `),
  });
}

async function sendAccountRejectedEmail({ to, name, role, reason }) {
  const roleLabel = role === 'brand' ? 'brand' : role === 'agency' ? 'agency' : 'creator';

  await sendEmail({
    to,
    subject: 'Update on your Fanitt profile review',
    html: wrapEmail(`
      <h2>Hi ${name},</h2>
      <p>We've reviewed your ${roleLabel} profile on Fanitt and it needs a few changes before it can be approved.</p>
      ${reason ? `<p style="background: #fef2f2; border-left: 3px solid #ef4444; padding: 12px 16px; color: #991b1b;">${reason}</p>` : ''}
      <p>You can update your details and resubmit anytime from your profile.</p>
    `),
  });
}

// ---------- Password reset ----------

async function sendPasswordResetEmail({ to, name, resetLink }) {
  await sendEmail({
    to,
    subject: 'Reset your Fanitt password',
    html: wrapEmail(`
      <h2>Hi ${name || 'there'},</h2>
      <p>We received a request to reset your Fanitt password. Click below to set a new one — this link expires in 15 minutes.</p>
      ${ctaButton(resetLink, 'Reset my password')}
      <p style="margin-top: 20px; font-size: 13px; color: #666;">If you didn't request this, you can safely ignore this email — your password won't be changed.</p>
    `),
  });
}

// ---------- Withdrawals ----------

async function sendWithdrawalCompletedEmail({ to, name, netAmount, payoutMethod }) {
  await sendEmail({
    to,
    subject: `Your withdrawal of ${formatRupees(netAmount)} is complete`,
    html: wrapEmail(`
      <h2 style="color: #10b981;">Payout sent, ${name}!</h2>
      <p>Your withdrawal of <b>${formatRupees(netAmount)}</b> has been sent to your ${payoutMethod === 'upi' ? 'UPI ID' : 'bank account'}.</p>
      <p>It should reflect in your account shortly, depending on your bank's processing time.</p>
      ${ctaButton('https://fanitt.com/wallet', 'View wallet')}
    `),
  });
}

async function sendWithdrawalRejectedEmail({ to, name, amount, reason }) {
  await sendEmail({
    to,
    subject: 'Your withdrawal request was declined',
    html: wrapEmail(`
      <h2>Hi ${name},</h2>
      <p>Your withdrawal request of <b>${formatRupees(amount)}</b> couldn't be processed, and the full amount has been refunded to your Fanitt wallet.</p>
      ${reason ? `<p style="background: #fef2f2; border-left: 3px solid #ef4444; padding: 12px 16px; color: #991b1b;">${reason}</p>` : ''}
      <p>You're welcome to submit a new withdrawal request anytime.</p>
      ${ctaButton('https://fanitt.com/wallet', 'View wallet')}
    `),
  });
}

// ---------- Milestones / Escrow ----------

async function sendMilestoneFundedEmail({ to, name, campaignTitle, milestoneTitle, amount }) {
  await sendEmail({
    to,
    subject: `${milestoneTitle} funded — you can start work`,
    html: wrapEmail(`
      <h2 style="color: #10b981;">Escrow funded!</h2>
      <p>Hi ${name}, the brand has funded <b>${milestoneTitle}</b> (${formatRupees(amount)}) on the campaign "<b>${campaignTitle}</b>".</p>
      <p>This amount is held safely in escrow and will be released to you once your work is approved. You can start work now.</p>
      ${ctaButton('https://fanitt.com/proposals', 'View campaign')}
    `),
  });
}

async function sendMilestoneSubmittedEmail({ to, name, campaignTitle, milestoneTitle }) {
  await sendEmail({
    to,
    subject: `New submission for ${milestoneTitle} — review needed`,
    html: wrapEmail(`
      <h2>Hi ${name},</h2>
      <p>The creator has submitted work for <b>${milestoneTitle}</b> on your campaign "<b>${campaignTitle}</b>".</p>
      <p>Please review it and either approve the payment release, request changes, or raise a dispute if needed.</p>
      ${ctaButton('https://fanitt.com/campaigns', 'Review submission')}
    `),
  });
}

async function sendMilestoneReleasedEmail({ to, name, campaignTitle, milestoneTitle, amount }) {
  await sendEmail({
    to,
    subject: `${formatRupees(amount)} released for ${milestoneTitle}!`,
    html: wrapEmail(`
      <h2 style="color: #10b981;">Payment released, ${name}!</h2>
      <p>Your work on <b>${milestoneTitle}</b> ("${campaignTitle}") has been approved, and <b>${formatRupees(amount)}</b> has been credited to your Fanitt wallet.</p>
      ${ctaButton('https://fanitt.com/wallet', 'View wallet')}
    `),
  });
}

async function sendMilestoneChangesRequestedEmail({ to, name, campaignTitle, milestoneTitle, changeDescription }) {
  await sendEmail({
    to,
    subject: `Changes requested for ${milestoneTitle}`,
    html: wrapEmail(`
      <h2>Hi ${name},</h2>
      <p>The brand has requested changes to your submission for <b>${milestoneTitle}</b> on "<b>${campaignTitle}</b>":</p>
      <p style="background: #fffbeb; border-left: 3px solid #f59e0b; padding: 12px 16px;">${changeDescription}</p>
      ${ctaButton('https://fanitt.com/proposals', 'View & resubmit')}
    `),
  });
}

async function sendDisputeRaisedEmail({ to, campaignTitle, milestoneTitle, reason }) {
  await sendEmail({
    to,
    subject: `Dispute raised — ${milestoneTitle} ("${campaignTitle}")`,
    html: wrapEmail(`
      <h2 style="color: #ef4444;">New dispute needs review</h2>
      <p>A dispute was raised on <b>${milestoneTitle}</b>, campaign "<b>${campaignTitle}</b>".</p>
      <p style="background: #fef2f2; border-left: 3px solid #ef4444; padding: 12px 16px;">${reason}</p>
      ${ctaButton('https://fanitt.com/admin/escrow-disputes', 'Review dispute')}
    `),
  });
}

// ---------- Subscriptions ----------
// Ready to wire in once subscription.controller.js is available — not
// called from anywhere yet.

async function sendSubscriptionConfirmationEmail({ to, name, planName, price, billingCycle }) {
  await sendEmail({
    to,
    subject: `You're on ${planName}! 🎉`,
    html: wrapEmail(`
      <h2 style="color: #F9436E;">Welcome to ${planName}, ${name}!</h2>
      <p>Your subscription is active. You've been charged <b>${formatRupees(price)}</b> (billed ${billingCycle}).</p>
      <p>Keep this email as your receipt for this transaction.</p>
      ${ctaButton('https://fanitt.com/pricing', 'Manage subscription')}
    `),
  });
}

async function sendSubscriptionPaymentFailedEmail({ to, name, planName }) {
  await sendEmail({
    to,
    subject: 'Your Fanitt subscription payment failed',
    html: wrapEmail(`
      <h2>Hi ${name},</h2>
      <p>We couldn't process your payment for <b>${planName}</b>. Please update your payment method or retry to keep your plan active.</p>
      ${ctaButton('https://fanitt.com/pricing', 'Retry payment')}
    `),
  });
}

// ---------- Sessions ----------
// Ready to wire in once the session/booking controller is available —
// not called from anywhere yet.

async function sendSessionBookingConfirmationEmail({ to, name, sessionTitle, scheduledAt, otherPartyName }) {
  const formattedDate = new Date(scheduledAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  await sendEmail({
    to,
    subject: `Booking confirmed: ${sessionTitle}`,
    html: wrapEmail(`
      <h2 style="color: #10b981;">You're booked in, ${name}!</h2>
      <p><b>${sessionTitle}</b> with ${otherPartyName} is confirmed for <b>${formattedDate}</b>.</p>
      ${ctaButton('https://fanitt.com/bookings', 'View booking')}
    `),
  });
}

async function sendSessionReminderEmail({ to, name, sessionTitle, scheduledAt, otherPartyName }) {
  const formattedTime = new Date(scheduledAt).toLocaleString('en-IN', { timeStyle: 'short' });
  await sendEmail({
    to,
    subject: `Reminder: ${sessionTitle} starts soon`,
    html: wrapEmail(`
      <h2>Hi ${name},</h2>
      <p>Just a reminder — <b>${sessionTitle}</b> with ${otherPartyName} starts at <b>${formattedTime}</b> today.</p>
      ${ctaButton('https://fanitt.com/bookings', 'View booking')}
    `),
  });
}

async function sendSessionCancelledEmail({ to, name, sessionTitle, scheduledAt, otherPartyName }) {
  const formattedDate = new Date(scheduledAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  await sendEmail({
    to,
    subject: `Cancelled: ${sessionTitle}`,
    html: wrapEmail(`
      <h2 style="color: #ef4444;">Hi ${name},</h2>
      <p><b>${sessionTitle}</b> with ${otherPartyName}, scheduled for ${formattedDate}, has been cancelled.</p>
      ${ctaButton('https://fanitt.com/bookings', 'View bookings')}
    `),
  });
}

module.exports = {
  sendEmail,
  sendAccountApprovedEmail,
  sendAccountRejectedEmail,
  sendPasswordResetEmail,
  sendWithdrawalCompletedEmail,
  sendWithdrawalRejectedEmail,
  sendMilestoneFundedEmail,
  sendMilestoneSubmittedEmail,
  sendMilestoneReleasedEmail,
  sendMilestoneChangesRequestedEmail,
  sendDisputeRaisedEmail,
  sendSubscriptionConfirmationEmail,
  sendSubscriptionPaymentFailedEmail,
  sendSessionBookingConfirmationEmail,
  sendSessionReminderEmail,
  sendSessionCancelledEmail,
};