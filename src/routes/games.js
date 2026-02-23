const express = require('express');
const router = express.Router();
const gameController = require('../controllers/gameController');
const { clerkAuthMiddleware, authRequired } = require('../middleware/clerkAuth');

// Apply Clerk middleware to all game routes
router.use(clerkAuthMiddleware);

// Oyun oluştur
router.post('/create', gameController.createGame);

// Belirli oyunu getir
router.get('/:gameId', gameController.getGame);

// Kullanıcının oyunlarını getir (auth + owner check required)
router.get('/user/:userId', authRequired, gameController.getUserGames);

// Hamle yap
router.put('/:gameId/move', gameController.makeMove);

// Oyundan çekil
router.put('/:gameId/resign', gameController.resignGame);

module.exports = router;
