const Game = require('../models/Game');
const User = require('../models/User');
const { Chess } = require('chess.js');
const mongoose = require('mongoose');

// Oyun oluştur
const createGame = async (req, res) => {
  try {
    const { whitePlayerId, blackPlayerId } = req.body;

    // Validasyonlar
    if (!whitePlayerId || !blackPlayerId) {
      return res.status(400).json({
        error: whitePlayerId ? 'Black player ID required' : 'White player ID required',
      });
    }

    if (whitePlayerId === blackPlayerId) {
      return res.status(400).json({ error: 'Players must be different' });
    }

    // Geçerli ObjectId kontrolü
    if (!mongoose.Types.ObjectId.isValid(whitePlayerId)) {
      return res.status(400).json({ error: 'Invalid white player ID' });
    }
    if (!mongoose.Types.ObjectId.isValid(blackPlayerId)) {
      return res.status(400).json({ error: 'Invalid black player ID' });
    }

    // Oyuncuların var olup olmadığını kontrol et
    const whitePlayer = await User.findById(whitePlayerId);
    const blackPlayer = await User.findById(blackPlayerId);

    if (!whitePlayer) {
      return res.status(404).json({ error: 'White player not found' });
    }
    if (!blackPlayer) {
      return res.status(404).json({ error: 'Black player not found' });
    }

    // Yeni oyun oluştur
    const game = await Game.create({
      whitePlayer: whitePlayerId,
      blackPlayer: blackPlayerId,
      pgn: '',
      status: 'ongoing',
      result: null,
    });

    res.status(201).json({
      _id: game._id,
      whitePlayer: whitePlayerId,
      blackPlayer: blackPlayerId,
      pgn: game.pgn,
      status: game.status,
      result: game.result,
      createdAt: game.createdAt,
      updatedAt: game.updatedAt,
    });
  } catch (error) {
    console.error('Error creating game:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

// Oyun detaylarını getir
const getGame = async (req, res) => {
  try {
    const { gameId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(gameId)) {
      return res.status(400).json({ error: 'Invalid game ID' });
    }

    const game = await Game.findById(gameId)
      .populate('whitePlayer', 'email firstName lastName')
      .populate('blackPlayer', 'email firstName lastName');

    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    res.json(game);
  } catch (error) {
    console.error('Error getting game:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

// Kullanıcının oyunlarını listele
const getUserGames = async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.query;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Kullanıcının var olup olmadığını kontrol et
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Query oluştur - hem whitePlayer hem blackPlayer olabilir
    const query = {
      $or: [{ whitePlayer: userId }, { blackPlayer: userId }],
    };

    // Status filter'ı varsa ekle
    if (status && ['ongoing', 'completed', 'abandoned'].includes(status)) {
      query.status = status;
    }

    const games = await Game.find(query)
      .populate('whitePlayer', 'email firstName lastName')
      .populate('blackPlayer', 'email firstName lastName')
      .sort({ createdAt: -1 }); // En yeni en üstte

    res.json({
      games,
      total: games.length,
    });
  } catch (error) {
    console.error('Error getting user games:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

// Hamle yap
const makeMove = async (req, res) => {
  try {
    const { gameId } = req.params;
    const { userId, move } = req.body;

    if (!mongoose.Types.ObjectId.isValid(gameId)) {
      return res.status(400).json({ error: 'Invalid game ID' });
    }

    if (!userId || !move) {
      return res.status(400).json({
        error: userId ? 'Move is required' : 'User ID is required',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Oyunu bul
    const game = await Game.findById(gameId);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    // Oyunun ongoing olduğunu kontrol et
    if (game.status !== 'ongoing') {
      return res.status(400).json({ error: 'Game is already completed' });
    }

    // Kullanıcının oyunda olduğunu kontrol et
    const whitePlayerId = game.whitePlayer.toString();
    const blackPlayerId = game.blackPlayer.toString();
    const userIdStr = userId.toString();

    if (userIdStr !== whitePlayerId && userIdStr !== blackPlayerId) {
      return res.status(403).json({ error: 'You are not in this game' });
    }

    // chess.js ile mevcut pozisyonu yükle
    const chess = new Chess();
    if (game.pgn) {
      chess.loadPgn(game.pgn);
    }

    // Sıra kontrolü
    const currentTurn = chess.turn(); // 'w' veya 'b'
    const isWhiteTurn = currentTurn === 'w';
    const isUserWhite = userIdStr === whitePlayerId;

    if (isWhiteTurn !== isUserWhite) {
      return res.status(400).json({ error: 'Not your turn' });
    }

    // Hamleyi dene
    const moveResult = chess.move(move);
    if (!moveResult) {
      return res.status(400).json({ error: 'Invalid move' });
    }

    // Yeni PGN'i al
    const newPgn = chess.pgn();

    // Oyun durumu kontrolü (hamle yapıldıktan sonra)
    let updatedStatus = game.status;
    let updatedResult = game.result;

    if (chess.isGameOver()) {
      updatedStatus = 'completed';
      if (chess.isCheckmate()) {
        // Kazanan: şu an sıra kimdeyse o kaybetti, karşı taraf kazandı
        // Hamle yapıldıktan sonra sıra değişti, bu yüzden currentTurn artık rakibin sırası
        const newTurn = chess.turn(); // Hamle yapıldıktan sonraki sıra
        updatedResult = newTurn === 'w' ? 'black' : 'white';
      } else if (chess.isDraw()) {
        updatedResult = 'draw';
      }
    }

    // Oyunu güncelle
    game.pgn = newPgn;
    game.status = updatedStatus;
    game.result = updatedResult;
    game.updatedAt = new Date();
    await game.save();

    // Populate edilmiş oyunu döndür
    const updatedGame = await Game.findById(gameId)
      .populate('whitePlayer', 'email firstName lastName')
      .populate('blackPlayer', 'email firstName lastName');

    res.json(updatedGame);
  } catch (error) {
    console.error('Error making move:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

// Oyundan çekil
const resignGame = async (req, res) => {
  try {
    const { gameId } = req.params;
    const { userId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(gameId)) {
      return res.status(400).json({ error: 'Invalid game ID' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Oyunu bul
    const game = await Game.findById(gameId);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    // Oyunun ongoing olduğunu kontrol et
    if (game.status !== 'ongoing') {
      return res.status(400).json({ error: 'Game is already completed' });
    }

    // Kullanıcının oyunda olduğunu kontrol et
    const whitePlayerId = game.whitePlayer.toString();
    const blackPlayerId = game.blackPlayer.toString();
    const userIdStr = userId.toString();

    if (userIdStr !== whitePlayerId && userIdStr !== blackPlayerId) {
      return res.status(403).json({ error: 'You are not in this game' });
    }

    // Kazananı belirle
    let result;
    if (userIdStr === whitePlayerId) {
      result = 'black'; // White çekildi, black kazandı
    } else {
      result = 'white'; // Black çekildi, white kazandı
    }

    // PGN sonuna resign sonucunu ekle
    let finalPgn = game.pgn || '';
    const resultNotation = result === 'white' ? '1-0' : '0-1';
    
    if (finalPgn) {
      // PGN varsa sonuna sonuç ekle
      finalPgn = `${finalPgn} ${resultNotation}`;
    } else {
      // PGN yoksa sadece sonuç
      finalPgn = resultNotation;
    }

    // Oyunu güncelle
    game.status = 'completed';
    game.result = result;
    game.pgn = finalPgn;
    game.updatedAt = new Date();

    await game.save();

    // Populate edilmiş oyunu döndür
    const updatedGame = await Game.findById(gameId)
      .populate('whitePlayer', 'email firstName lastName')
      .populate('blackPlayer', 'email firstName lastName');

    res.json(updatedGame);
  } catch (error) {
    console.error('Error resigning game:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

module.exports = {
  createGame,
  getGame,
  getUserGames,
  makeMove,
  resignGame,
};
