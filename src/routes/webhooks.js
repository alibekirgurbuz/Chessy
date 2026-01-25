const express = require('express');
const { Webhook } = require('svix');
const {
  handleUserCreated,
  handleUserUpdated,
  handleUserDeleted,
} = require('../controllers/webhookController');

const router = express.Router();

router.post('/clerk', async (req, res) => {
  try {
    console.log('Webhook received - Body type:', typeof req.body);
    console.log('Webhook received - Headers:', {
      'svix-id': req.headers['svix-id'] ? 'present' : 'missing',
      'svix-timestamp': req.headers['svix-timestamp'] ? 'present' : 'missing',
      'svix-signature': req.headers['svix-signature'] ? 'present' : 'missing',
    });

    const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error('CLERK_WEBHOOK_SECRET is not set');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    // Get headers
    const svixId = req.headers['svix-id'];
    const svixTimestamp = req.headers['svix-timestamp'];
    const svixSignature = req.headers['svix-signature'];

    if (!svixId || !svixTimestamp || !svixSignature) {
      console.error('Missing svix headers:', { 
        svixId: !!svixId, 
        svixTimestamp: !!svixTimestamp, 
        svixSignature: !!svixSignature 
      });
      return res.status(400).json({ error: 'Missing svix headers' });
    }

    // Get the raw body (Buffer'dan string'e çevir veya direkt string)
    let payload;
    if (Buffer.isBuffer(req.body)) {
      payload = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      payload = req.body;
    } else {
      payload = JSON.stringify(req.body);
    }

    console.log('Payload length:', payload.length);

    // Create a new Svix instance with the webhook secret
    const wh = new Webhook(webhookSecret);

    let evt;

    try {
      // Verify the webhook
      evt = wh.verify(payload, {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': svixSignature,
      });
      console.log('Webhook verified successfully');
    } catch (err) {
      console.error('Webhook verification error:', err);
      console.error('Error details:', {
        message: err.message,
        stack: err.stack,
      });
      return res.status(400).json({ error: 'Invalid signature', details: err.message });
    }

    // Handle the webhook event
    const eventType = evt.type;
    console.log('Received webhook event:', eventType);

    try {
      switch (eventType) {
        case 'user.created':
          await handleUserCreated(evt);
          break;
        case 'user.updated':
          await handleUserUpdated(evt);
          break;
        case 'user.deleted':
          await handleUserDeleted(evt);
          break;
        default:
          console.log('Unhandled event type:', eventType);
      }
    } catch (handlerError) {
      console.error('Error in event handler:', handlerError);
      console.error('Handler error stack:', handlerError.stack);
      throw handlerError;
    }

    res.status(200).json({ received: true, event: eventType });
  } catch (error) {
    console.error('Webhook error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

module.exports = router;
