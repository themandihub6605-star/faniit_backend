// src/controllers/whatsapp.controller.js
const WhatsAppAccount = require('../models/WhatsAppAccount.model');

// GET /api/whatsapp/webhook — Meta verification handshake
// Read from raw URL: sanitizers (e.g. express-mongo-sanitize) strip dotted keys like "hub.mode" from req.query
const verifyWebhook = (req, res) => {
  const params = new URL(req.originalUrl, 'http://localhost').searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    // Must be plain text, status 200
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
};

/** Text shown on the connect page for one incoming message. */
function messageText(message) {
  switch (message.type) {
    case 'text':
      return message.text?.body || '';
    case 'button':
      return message.button?.text || '';
    case 'interactive':
      return message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
    default:
      return `[${message.type}]`;
  }
}

// POST /api/whatsapp/webhook — incoming messages & status updates
const receiveWebhook = async (req, res) => {
  // Respond immediately, Meta retries if it doesn't get 200 quickly
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        // The Fanitt user who connected this number (numbers not connected
        // through fanitt.com/connect/whatsapp are only logged).
        const acc = await WhatsAppAccount.findOne({ phoneNumberId, status: 'connected' });

        for (const message of value.messages || []) {
          console.log('[WhatsApp] message:', message.from, message.type);
          if (!acc) continue;
          acc.addMessage({
            direction: 'in',
            waMessageId: message.id || '',
            peer: message.from || '',
            kind: message.type || 'text',
            text: messageText(message).slice(0, 1000),
            status: 'received',
            at: message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date(),
          });
        }

        for (const status of value.statuses || []) {
          console.log('[WhatsApp] status:', status.id, status.status);
          if (!acc) continue;
          const sent = acc.messages.find((m) => m.direction === 'out' && m.waMessageId === status.id);
          if (sent) {
            sent.status = status.status;
            if (status.status === 'failed') {
              acc.lastError = status.errors?.[0]?.title || status.errors?.[0]?.message || 'Message failed';
            }
          }
        }

        if (acc && acc.isModified()) await acc.save();
      }
    }
  } catch (err) {
    console.error('[WhatsApp] webhook processing error:', err);
  }
};

module.exports = { verifyWebhook, receiveWebhook };