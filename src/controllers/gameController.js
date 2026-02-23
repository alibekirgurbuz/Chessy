const Game = require('../models/Game');
const User = require('../models/User');
const { Chess } = require('chess.js');
const mongoose = require('mongoose');

// ──────────────────────────────────────────────
// Helper: Enrich games with player info via manual User lookup
// (Game.whitePlayer/blackPlayer are Clerk ID strings, not ObjectId refs,
//  so populate() does NOT work. We resolve player details manually.)
// ──────────────────────────────────────────────
async function enrichGamesWithPlayerInfo(games) {
  // Collect unique Clerk IDs from all games
  const clerkIds = new Set();
  for (const g of games) {
    if (g.whitePlayer) clerkIds.add(g.whitePlayer.toString());
    if (g.blackPlayer) clerkIds.add(g.blackPlayer.toString());
  }

  if (clerkIds.size === 0) return games;

  // Single DB query for all unique players
  const users = await User.find(
    { clerkId: { $in: [...clerkIds] } },
    'clerkId email firstName lastName username imageUrl'
  );

  // Build lookup map: clerkId → user info
  const userMap = {};
  for (const u of users) {
    userMap[u.clerkId] = {
      _id: u._id,
      clerkId: u.clerkId,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      username: u.username,
      imageUrl: u.imageUrl,
      displayName: u.displayName, // virtual
    };
  }

  // Enrich each game
  return games.map((g) => {
    const gameObj = g.toObject ? g.toObject() : { ...g };
    const whiteId = gameObj.whitePlayer?.toString();
    const blackId = gameObj.blackPlayer?.toString();

    gameObj.whitePlayer = userMap[whiteId] || { clerkId: whiteId, username: 'Unknown' };
    gameObj.blackPlayer = userMap[blackId] || { clerkId: blackId, username: 'Unknown' };

    return gameObj;
  });
}

// Helper: Enrich a single game
async function enrichGameWithPlayerInfo(game) {
  const enriched = await enrichGamesWithPlayerInfo([game]);
  return enriched[0];
}

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

    const game = await Game.findById(gameId);

    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    const enrichedGame = await enrichGameWithPlayerInfo(game);
    res.json(enrichedGame);
  } catch (error) {
    console.error('Error getting game:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

// Kullanıcının oyunlarını listele
// userId param = Clerk ID (string), NOT MongoDB ObjectId
const getUserGames = async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.query;

    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Owner check: authenticated user can only access their own games
    const { getAuth } = require('../middleware/clerkAuth');
    const auth = getAuth(req);
    const authenticatedClerkId = auth?.userId;

    if (!authenticatedClerkId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (authenticatedClerkId !== userId) {
      return res.status(403).json({ error: 'Forbidden: You can only access your own games' });
    }

    // Query — whitePlayer/blackPlayer store Clerk ID strings
    const query = {
      $or: [{ whitePlayer: userId }, { blackPlayer: userId }],
    };

    // Status filter
    if (status && ['ongoing', 'completed', 'abandoned'].includes(status)) {
      query.status = status;
    }

    const games = await Game.find(query)
      .sort({ createdAt: -1 }); // En yeni en üstte

    // Enrich with player info via manual lookup
    const enrichedGames = await enrichGamesWithPlayerInfo(games);

    res.json({
      games: enrichedGames,
      total: enrichedGames.length,
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

    // Enriched oyunu döndür
    const updatedGame = await Game.findById(gameId);
    const enrichedGame = await enrichGameWithPlayerInfo(updatedGame);

    res.json(enrichedGame);
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

    // Enriched oyunu döndür
    const updatedGame = await Game.findById(gameId);
    const enrichedGame = await enrichGameWithPlayerInfo(updatedGame);

    res.json(enrichedGame);
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
