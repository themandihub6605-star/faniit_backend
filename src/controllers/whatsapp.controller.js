// src/controllers/whatsapp.controller.js

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

// POST /api/whatsapp/webhook — incoming messages & status updates
const receiveWebhook = (req, res) => {
  // Respond immediately, Meta retries if it doesn't get 200 quickly
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        for (const message of value.messages || []) {
          // TODO: handle incoming message
          console.log('[WhatsApp] message:', message.from, message.type);
        }

        for (const status of value.statuses || []) {
          // TODO: handle delivery/read status
          console.log('[WhatsApp] status:', status.id, status.status);
        }
      }
    }
  } catch (err) {
    console.error('[WhatsApp] webhook processing error:', err);
  }
};

module.exports = { verifyWebhook, receiveWebhook };