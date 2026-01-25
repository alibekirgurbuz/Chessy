const express = require('express');
const router = express.Router();
const gameController = require('../controllers/gameController');

// Oyun oluştur
router.post('/create', gameController.createGame);

// Belirli oyunu getir
router.get('/:gameId', gameController.getGame);

// Kullanıcının oyunlarını getir
router.get('/user/:userId', gameController.getUserGames);

// Hamle yap
router.put('/:gameId/move', gameController.makeMove);

// Oyundan çekil
router.put('/:gameId/resign', gameController.resignGame);

module.exports = router;
