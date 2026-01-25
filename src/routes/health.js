const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

// Basic health check
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Database health check
router.get('/db', (req, res) => {
  const dbStatus = mongoose.connection.readyState;
  const statusMap = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: statusMap[dbStatus] || 'unknown',
  });
});

module.exports = router;
