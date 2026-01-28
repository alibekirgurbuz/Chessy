const express = require('express');
const { Webhook } = require('svix');
const {
  handleUserCreated,
  handleUserUpdated,
  handleUserDeleted,
} = require('../controllers/webhookController');

const router = express.Router();

router.post('/clerk', async (req, res) => {
  const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

  if (!WEBHOOK_SECRET) {
    console.error('CLERK_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  // Get headers
  const svix_id = req.headers['svix-id'];
  const svix_timestamp = req.headers['svix-timestamp'];
  const svix_signature = req.headers['svix-signature'];

  // If there are no headers, error out
  if (!svix_id || !svix_timestamp || !svix_signature) {
    console.error('Missing svix headers');
    return res.status(400).json({ error: 'Missing svix headers' });
  }

  // Get the raw body
  let payload = req.body;
  if (Buffer.isBuffer(payload)) {
    payload = payload.toString('utf8');
  } else if (typeof payload !== 'string') {
    payload = JSON.stringify(payload);
  }

  const wh = new Webhook(WEBHOOK_SECRET);
  let evt;

  try {
    evt = wh.verify(payload, {
      'svix-id': svix_id,
      'svix-timestamp': svix_timestamp,
      'svix-signature': svix_signature,
    });
    console.log('Webhook verified successfully');
  } catch (err) {
    console.error('Webhook verification failed:', err.message);
    return res.status(400).json({ 
      error: 'Webhook verification failed', 
      details: err.message 
    });
  }

  const { type, data } = evt;
  console.log(`Received webhook event: ${type}`);

  try {
    switch (type) {
      case 'user.created':
        console.log(`Processing user.created for ${data.id}`);
        await handleUserCreated(evt);
        console.log('User created successfully:', data.id);
        break;
      
      case 'user.updated':
        console.log(`Processing user.updated for ${data.id}`);
        await handleUserUpdated(evt);
        console.log('User updated successfully:', data.id);
        break;
      
      case 'user.deleted':
        console.log(`Processing user.deleted for ${data.id}`);
        await handleUserDeleted(evt);
        console.log('User deleted successfully:', data.id);
        break;
      
      default:
        console.log('Unhandled webhook event type:', type);
    }

    // Success response
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error(`Error processing webhook ${type}:`, err);
    return res.status(400).json({ 
      success: false, 
      error: err.message 
    });
  }
});

module.exports = router;
