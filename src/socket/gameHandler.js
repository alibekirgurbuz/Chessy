const Game = require('../models/Game');
const { Chess } = require('chess.js');

function gameHandler(io, socket) {
    // Oyuna katıl
    socket.on('join_game', async ({ gameId }) => {
        try {
            const game = await Game.findById(gameId)
                .populate('whitePlayer blackPlayer');

            if (!game) {
                return socket.emit('error', { message: 'Game not found' });
            }

            // Socket'i oyun odasına ekle
            socket.join(gameId);

            // Odadaki diğer kullanıcılara bildir
            socket.to(gameId).emit('opponent_joined', {
                opponentId: socket.userId
            });

            // PGN'den FEN ve current turn hesapla
            const chess = new Chess();
            if (game.pgn) {
                try {
                    chess.loadPgn(game.pgn);
                } catch (e) {
                    console.error('PGN load error:', e);
                }
            }

            // Mevcut oyun durumunu gönder (FEN ve currentTurn ile)
            socket.emit('game_state', {
                game: {
                    ...game.toObject(),
                    fen: chess.fen(),
                    currentTurn: chess.turn()
                }
            });

            console.log(`User ${socket.userId} joined game ${gameId}, FEN: ${chess.fen()}`);

        } catch (error) {
            console.error('join_game error:', error);
            socket.emit('error', { message: error.message });
        }
    });

    // Hamle yap
    socket.on('make_move', async ({ gameId, move }) => {
        try {
            const game = await Game.findById(gameId);

            if (!game) {
                return socket.emit('error', { message: 'Game not found' });
            }

            // Kullanıcının oyunda olduğunu kontrol et
            const isPlayer = game.whitePlayer.toString() === socket.userId ||
                game.blackPlayer.toString() === socket.userId;

            if (!isPlayer) {
                return socket.emit('error', { message: 'You are not in this game' });
            }

            // Chess.js ile hamleyi validate et
            const chess = new Chess();
            if (game.pgn) {
                chess.loadPgn(game.pgn);
            }

            // Sıra kontrolü
            const isWhiteTurn = chess.turn() === 'w';
            const isWhitePlayer = game.whitePlayer.toString() === socket.userId;

            if ((isWhiteTurn && !isWhitePlayer) || (!isWhiteTurn && isWhitePlayer)) {
                return socket.emit('error', { message: 'Not your turn' });
            }

            const moveResult = chess.move(move);
            if (!moveResult) {
                return socket.emit('error', { message: 'Invalid move' });
            }

            // PGN'i güncelle
            game.pgn = chess.pgn();
            game.updatedAt = Date.now();

            // Mat/beraberlik kontrolü
            if (chess.isGameOver()) {
                game.status = 'completed';
                if (chess.isCheckmate()) {
                    // Kazananı belirle (sıra kimde ise o kaybetti)
                    game.result = chess.turn() === 'w' ? 'black' : 'white';
                } else if (chess.isDraw()) {
                    game.result = 'draw';
                }
            }

            await game.save();

            // Odadaki herkese hamleyi yayınla
            io.to(gameId).emit('move_made', {
                gameId,
                move: moveResult.san,
                from: moveResult.from,
                to: moveResult.to,
                pgn: game.pgn,
                currentTurn: chess.turn(),
                fen: chess.fen()
            });

            // Oyun bittiyse bildir
            if (game.status === 'completed') {
                io.to(gameId).emit('game_over', {
                    gameId,
                    result: game.result,
                    reason: chess.isCheckmate() ? 'checkmate' : 'draw'
                });
            }

            console.log(`Move made in game ${gameId}: ${moveResult.san}`);

        } catch (error) {
            console.error('make_move error:', error);
            socket.emit('error', { message: error.message });
        }
    });

    // Oyundan ayrıl
    socket.on('leave_game', ({ gameId }) => {
        socket.leave(gameId);
        socket.to(gameId).emit('opponent_disconnected');
        console.log(`User ${socket.userId} left game ${gameId}`);
    });
    // Pes et
    socket.on('resign_game', async ({ gameId }) => {
        try {
            const game = await Game.findById(gameId);

            if (!game) {
                return socket.emit('error', { message: 'Game not found' });
            }

            // Kullanıcının oyunda olduğunu kontrol et
            const isPlayer = game.whitePlayer.toString() === socket.userId ||
                game.blackPlayer.toString() === socket.userId;

            if (!isPlayer) {
                return socket.emit('error', { message: 'You are not in this game' });
            }

            if (game.status !== 'ongoing') {
                return socket.emit('error', { message: 'Game is already completed' });
            }

            const isWhitePlayer = game.whitePlayer.toString() === socket.userId;

            // Kazananı belirle (Resign eden kaybeder)
            game.status = 'completed';
            game.result = isWhitePlayer ? 'black' : 'white';
            game.updatedAt = Date.now();

            await game.save();

            // Odadaki herkese bildir
            io.to(gameId).emit('game_over', {
                gameId,
                result: game.result,
                reason: 'resignation'
            });

            console.log(`User ${socket.userId} resigned from game ${gameId}`);

        } catch (error) {
            console.error('resign_game error:', error);
            socket.emit('error', { message: error.message });
        }
    });
}

module.exports = gameHandler;
