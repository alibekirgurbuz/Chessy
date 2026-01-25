const express = require('express');
const router = express.Router();
const matchmakingController = require('../controllers/matchmakingController');

// Kuyruk durumu
router.get('/queue/status', matchmakingController.getQueueStatus);

// Online kullanıcı sayısı
router.get('/online', matchmakingController.getOnlineUsers);

module.exports = router;
