const Game = require('../models/Game');
const { Chess } = require('chess.js');
const ClockManager = require('../services/ClockManager');
const premoveManager = require('../services/PremoveManager');
const PremoveTracer = require('../services/PremoveTracer');
const logger = require('../utils/logger');

function gameHandler(io, socket, onlineUsers) {
    // ——— Helper: determine player color ('white'|'black') from socket.userId ———
    function getPlayerColor(game) {
        if (game.whitePlayer.toString() === socket.userId) return 'white';
        if (game.blackPlayer.toString() === socket.userId) return 'black';
        return null;
    }

    // ——— Helper: execute a premove from the queue (called inside the lock) ———
    async function tryExecuteQueuedPremove(game, chess, gameId) {
        // Determine whose turn it is now (after the normal move)
        const turnChar = chess.turn(); // 'w' or 'b'
        const premoveColor = turnChar === 'w' ? 'white' : 'black';

        // ── TRACE: turn_flipped ──
        const trace = PremoveTracer.start(gameId, premoveColor, chess.history().length);
        trace.mark('turn_flipped');

        const queuedPremove = premoveManager.getPremove(gameId, premoveColor);
        if (!queuedPremove) return;

        // ── TRACE: queued_premove_found ──
        trace.mark('queued_premove_found', {
            from: queuedPremove.from,
            to: queuedPremove.to,
            promotion: queuedPremove.promotion || null
        });

        // Capture clock before premove
        let clockBefore = null;
        if (game.clock) {
            const tmpClock = ClockManager.fromJSON(game.clock);
            const st = tmpClock.getState();
            clockBefore = premoveColor === 'white' ? st.whiteTime : st.blackTime;
        }

        // ── TRACE: premove_execute_start ──
        trace.mark('premove_execute_start');

        try {
            const moveResult = chess.move({
                from: queuedPremove.from,
                to: queuedPremove.to,
                promotion: queuedPremove.promotion || 'q'
            });

            if (!moveResult) {
                throw new Error('Invalid premove');
            }

            // ===== CLOCK for premove =====
            let clockState = null;
            let clockAfter = null;
            if (game.clock) {
                const clock = ClockManager.fromJSON(game.clock);
                const playerClockColor = turnChar; // 'w' or 'b'

                try {
                    clockState = clock.makeMove(playerClockColor, Date.now());

                    if (clockState.timeout) {
                        game.status = 'completed';
                        game.result = clockState.winner;
                        game.clock = clock.toJSON();
                        game.pgn = chess.pgn();
                        game.updatedAt = Date.now();

                        premoveManager.clearPremove(gameId, premoveColor, 'executed_timeout');
                        game.queuedPremoves = { white: null, black: null };
                        await game.save();

                        io.to(gameId).emit('game_over', {
                            gameId,
                            result: clockState.winner,
                            reason: 'timeout'
                        });
                        io.to(gameId).emit('clock_update', clockState);
                        premoveManager.clearAll(gameId, 'game_over');

                        trace.mark('premove_execute_end', { outcome: 'timeout' });
                        trace.summary();
                        return;
                    }

                    game.clock = clock.toJSON();
                    clockAfter = premoveColor === 'white' ? clockState.whiteTime : clockState.blackTime;
                } catch (clockError) {
                    console.error('Premove clock error:', clockError);
                    premoveManager.clearPremove(gameId, premoveColor, 'clock_error');
                    game.queuedPremoves[premoveColor] = null;
                    await game.save();

                    const premovePlayerId = premoveColor === 'white'
                        ? game.whitePlayer.toString()
                        : game.blackPlayer.toString();
                    const premoveSocket = findSocketByUserId(premovePlayerId);
                    if (premoveSocket) {
                        premoveSocket.emit('premove_rejected', {
                            gameId,
                            reason: clockError.message
                        });
                    }
                    io.to(gameId).emit('premove_cleared', {
                        gameId,
                        by: premoveColor,
                        reason: 'rejected'
                    });

                    trace.mark('premove_rejected', { reason: clockError.message });
                    trace.summary();
                    return;
                }
            }
            // ===== END CLOCK =====

            // ── TRACE: premove_execute_end ──
            trace.mark('premove_execute_end', {
                move: moveResult.san,
                clock_before_ms: clockBefore,
                clock_after_ms: clockAfter,
                clock_delta_ms: (clockBefore != null && clockAfter != null) ? clockBefore - clockAfter : null
            });

            // Update game state
            game.pgn = chess.pgn();
            game.updatedAt = Date.now();

            // Check game over after premove
            if (chess.isGameOver()) {
                game.status = 'completed';
                if (chess.isCheckmate()) {
                    game.result = chess.turn() === 'w' ? 'black' : 'white';
                    game.resultReason = 'checkmate';
                } else if (chess.isDraw()) {
                    game.result = 'draw';
                    game.resultReason = chess.isStalemate() ? 'stalemate' : 'draw';
                }
            }

            // Clear the executed premove
            premoveManager.clearPremove(gameId, premoveColor, 'executed');
            game.queuedPremoves[premoveColor] = null;
            await game.save();

            // Broadcast the premove as a normal move_made
            io.to(gameId).emit('move_made', {
                gameId,
                move: moveResult.san,
                from: moveResult.from,
                to: moveResult.to,
                pgn: game.pgn,
                currentTurn: chess.turn(),
                fen: chess.fen(),
                moveCount: chess.history().length
            });

            // ── TRACE: move_broadcast_sent ──
            trace.mark('move_broadcast_sent');

            // Broadcast clock
            if (clockState) {
                io.to(gameId).emit('clock_update', clockState);
                // ── TRACE: clock_update_sent ──
                trace.mark('clock_update_sent');
            }

            // Notify premove cleared (executed)
            io.to(gameId).emit('premove_cleared', {
                gameId,
                by: premoveColor,
                reason: 'executed'
            });

            // ── TRACE: summary ──
            trace.summary();

            // Check game over after premove
            if (game.status === 'completed') {
                io.to(gameId).emit('game_over', {
                    gameId,
                    result: game.result,
                    reason: chess.isCheckmate() ? 'checkmate' : 'draw'
                });
                premoveManager.clearAll(gameId, 'game_over');
            }

        } catch (e) {
            // Premove is invalid
            premoveManager.clearPremove(gameId, premoveColor, 'rejected');
            game.queuedPremoves[premoveColor] = null;
            await game.save();

            // ── TRACE: premove_rejected ──
            trace.mark('premove_rejected', {
                from: queuedPremove.from,
                to: queuedPremove.to,
                reason: e.message
            });
            trace.summary();

            // Notify the premove player
            const premovePlayerId = premoveColor === 'white'
                ? game.whitePlayer.toString()
                : game.blackPlayer.toString();
            const premoveSocket = findSocketByUserId(premovePlayerId);
            if (premoveSocket) {
                premoveSocket.emit('premove_rejected', {
                    gameId,
                    reason: e.message || 'Invalid premove'
                });
            }

            io.to(gameId).emit('premove_cleared', {
                gameId,
                by: premoveColor,
                reason: 'rejected'
            });
        }
    }

    // ——— Helper: find socket by userId ———
    function findSocketByUserId(userId) {
        const socketId = onlineUsers.get(userId);
        if (!socketId) return null;
        return io.sockets.sockets.get(socketId) || null;
    }

    // ==================== JOIN GAME ====================
    socket.on('join_game', async ({ gameId }) => {
        try {
            const game = await Game.findById(gameId)
                .populate('whitePlayer blackPlayer');

            if (!game) {
                return socket.emit('error', { message: 'Game not found' });
            }

            // Socket'i oyun odasına ekle
            socket.join(gameId);

            // Cancel any pending disconnect timeout if the disconnected user is rejoining
            if (game.disconnectedPlayerId === socket.userId) {
                game.disconnectedPlayerId = null;
                game.disconnectDeadlineAt = null;
                await game.save();
                io.to(gameId).emit('opponent_reconnected', { playerId: socket.userId });
                console.log(`User ${socket.userId} reconnected to game ${gameId}, cancelled disconnect timeout.`);
            }

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

            // Fetch user details for white and black players to get isOnline status
            const User = require('../models/User');
            const mongoose = require('mongoose');

            const whiteId = game.whitePlayer.toString();
            const blackId = game.blackPlayer.toString();

            // Only query DB for valid ObjectIds (registered users)
            const userIdsToFetch = [whiteId, blackId].filter(id => mongoose.Types.ObjectId.isValid(id));

            let players = [];
            if (userIdsToFetch.length > 0) {
                try {
                    players = await User.find({ _id: { $in: userIdsToFetch } });
                } catch (err) {
                    console.error('Error fetching users in join_game:', err);
                }
            }

            const whiteUser = players.find(p => p._id.toString() === whiteId);
            const blackUser = players.find(p => p._id.toString() === blackId);

            const whitePlayerInfo = {
                _id: whiteId,
                username: whiteUser ? whiteUser.username : (whiteId.startsWith('user_') ? 'Misafir Oyuncu' : 'Unknown'),
                isOnline: (whiteUser && whiteUser.isOnline) || (onlineUsers && onlineUsers.has(whiteId)) || false
            };

            const blackPlayerInfo = {
                _id: blackId,
                username: blackUser ? blackUser.username : (blackId.startsWith('user_') ? 'Misafir Oyuncu' : 'Unknown'),
                isOnline: (blackUser && blackUser.isOnline) || (onlineUsers && onlineUsers.has(blackId)) || false
            };

            // Mevcut oyun durumunu gönder
            socket.emit('game_state', {
                game: {
                    ...game.toObject(),
                    whitePlayer: whitePlayerInfo,
                    blackPlayer: blackPlayerInfo,
                    fen: chess.fen(),
                    currentTurn: chess.turn(),
                    moveCount: chess.history().length,
                    serverTimestamp: Date.now()
                }
            });

            // Send initial clock update
            if (game.clock) {
                const clock = ClockManager.fromJSON(game.clock);
                io.to(gameId).emit('clock_update', clock.getState());
            }

            logger.debug(`User ${socket.userId} joined game ${gameId}, FEN: ${chess.fen()}`);

        } catch (error) {
            console.error('join_game error:', error);
            socket.emit('error', { message: error.message });
        }
    });

    // ==================== MAKE MOVE (with premove auto-execute) ====================
    socket.on('make_move', async ({ gameId, move, clientTimestamp }) => {
        await premoveManager.withLock(gameId, async () => {
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

                // Clear the mover's own premove if they had one (they played a normal move instead)
                const moverColor = isWhitePlayer ? 'white' : 'black';
                if (premoveManager.getPremove(gameId, moverColor)) {
                    premoveManager.clearPremove(gameId, moverColor, 'normal_move_override');
                    game.queuedPremoves[moverColor] = null;
                    io.to(gameId).emit('premove_cleared', {
                        gameId,
                        by: moverColor,
                        reason: 'cancelled'
                    });
                }

                // ========== CLOCK LOGIC START ==========
                let clockState = null;
                if (game.clock) {
                    const clock = ClockManager.fromJSON(game.clock);
                    const playerColor = isWhitePlayer ? 'w' : 'b';

                    logger.debug('🕐 Clock Debug:', {
                        playerColor,
                        activeColor: clock.activeColor,
                        isWhitePlayer,
                        userId: socket.userId,
                        whitePlayer: game.whitePlayer.toString(),
                        blackPlayer: game.blackPlayer.toString()
                    });

                    try {
                        clockState = clock.makeMove(playerColor, clientTimestamp || Date.now());

                        // Check for timeout
                        if (clockState.timeout) {
                            game.status = 'completed';
                            game.result = clockState.winner;
                            game.clock = clock.toJSON();
                            await game.save();

                            io.to(gameId).emit('game_over', {
                                gameId,
                                result: clockState.winner,
                                reason: 'timeout'
                            });
                            io.to(gameId).emit('clock_update', clockState);
                            premoveManager.clearAll(gameId, 'game_over');
                            return;
                        }

                        game.clock = clock.toJSON();

                    } catch (clockError) {
                        console.error('Clock error:', clockError);
                        return socket.emit('error', { message: clockError.message });
                    }
                }
                // ========== CLOCK LOGIC END ==========

                // PGN'i güncelle
                game.pgn = chess.pgn();
                game.updatedAt = Date.now();

                // Mat/beraberlik kontrolü
                let isGameOver = false;
                if (chess.isGameOver()) {
                    isGameOver = true;
                    game.status = 'completed';
                    if (chess.isCheckmate()) {
                        game.result = chess.turn() === 'w' ? 'black' : 'white';
                        game.resultReason = 'checkmate';
                    } else if (chess.isDraw()) {
                        game.result = 'draw';
                        game.resultReason = chess.isStalemate() ? 'stalemate' : 'draw';
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
                    fen: chess.fen(),
                    moveCount: chess.history().length
                });

                // Broadcast clock update
                if (clockState) {
                    io.to(gameId).emit('clock_update', clockState);
                }

                // Oyun bittiyse bildir
                if (isGameOver) {
                    io.to(gameId).emit('game_over', {
                        gameId,
                        result: game.result,
                        reason: chess.isCheckmate() ? 'checkmate' : 'draw'
                    });
                    premoveManager.clearAll(gameId, 'game_over');
                }

                logger.debug(`Move made in game ${gameId}: ${moveResult.san}`);

                // ========== PREMOVE AUTO-EXECUTE ==========
                // If game is not over, try to execute the opponent's queued premove
                if (!isGameOver) {
                    await tryExecuteQueuedPremove(game, chess, gameId);
                }

            } catch (error) {
                console.error('make_move error:', error);
                socket.emit('error', { message: error.message });
            }
        });
    });

    // ==================== SET PREMOVE ====================
    socket.on('set_premove', async ({ gameId, premove }) => {
        await premoveManager.withLock(gameId, async () => {
            try {
                const game = await Game.findById(gameId);

                if (!game) {
                    return socket.emit('error', { message: 'Game not found' });
                }

                // Check game is ongoing
                if (game.status !== 'ongoing') {
                    return socket.emit('premove_rejected', {
                        gameId,
                        reason: 'Game is not active'
                    });
                }

                // Check player is in the game
                const playerColor = getPlayerColor(game);
                if (!playerColor) {
                    return socket.emit('error', { message: 'You are not in this game' });
                }

                // Check it's NOT the player's turn (premove = move when it's not your turn)
                const chess = new Chess();
                if (game.pgn) {
                    chess.loadPgn(game.pgn);
                }
                const currentTurnColor = chess.turn() === 'w' ? 'white' : 'black';
                if (currentTurnColor === playerColor) {
                    return socket.emit('premove_rejected', {
                        gameId,
                        reason: 'It is your turn — make a normal move'
                    });
                }

                // Validate premove data
                if (!premove || !premove.from || !premove.to) {
                    return socket.emit('premove_rejected', {
                        gameId,
                        reason: 'Invalid premove data'
                    });
                }

                // Store premove (overwrites any existing)
                premoveManager.setPremove(gameId, playerColor, premove);

                // Persist to DB
                if (!game.queuedPremoves) {
                    game.queuedPremoves = { white: null, black: null };
                }
                game.queuedPremoves[playerColor] = {
                    from: premove.from,
                    to: premove.to,
                    promotion: premove.promotion || null
                };
                await game.save();

                // Notify room
                io.to(gameId).emit('premove_set', {
                    gameId,
                    by: playerColor,
                    premove: { from: premove.from, to: premove.to, promotion: premove.promotion }
                });

            } catch (error) {
                console.error('set_premove error:', error);
                socket.emit('error', { message: error.message });
            }
        });
    });

    // ==================== CANCEL PREMOVE ====================
    socket.on('cancel_premove', async ({ gameId }) => {
        await premoveManager.withLock(gameId, async () => {
            try {
                const game = await Game.findById(gameId);

                if (!game) {
                    return socket.emit('error', { message: 'Game not found' });
                }

                const playerColor = getPlayerColor(game);
                if (!playerColor) {
                    return socket.emit('error', { message: 'You are not in this game' });
                }

                // Clear premove
                premoveManager.clearPremove(gameId, playerColor, 'cancelled');

                // Persist
                if (game.queuedPremoves) {
                    game.queuedPremoves[playerColor] = null;
                    await game.save();
                }

                // Notify room
                io.to(gameId).emit('premove_cleared', {
                    gameId,
                    by: playerColor,
                    reason: 'cancelled'
                });

            } catch (error) {
                console.error('cancel_premove error:', error);
                socket.emit('error', { message: error.message });
            }
        });
    });

    // ==================== LEAVE GAME ====================
    socket.on('leave_game', ({ gameId }) => {
        socket.leave(gameId);
        socket.to(gameId).emit('opponent_disconnected', { playerId: socket.userId });
        logger.debug(`User ${socket.userId} left game ${gameId}`);
    });

    // ==================== RESIGN ====================
    socket.on('resign_game', async ({ gameId }) => {
        try {
            const game = await Game.findById(gameId);

            if (!game) {
                return socket.emit('error', { message: 'Game not found' });
            }

            const isPlayer = game.whitePlayer.toString() === socket.userId ||
                game.blackPlayer.toString() === socket.userId;

            if (!isPlayer) {
                return socket.emit('error', { message: 'You are not in this game' });
            }

            if (game.status !== 'ongoing') {
                return socket.emit('error', { message: 'Game is already completed' });
            }

            const isWhitePlayer = game.whitePlayer.toString() === socket.userId;

            game.status = 'completed';
            game.result = isWhitePlayer ? 'black' : 'white';
            game.resultReason = 'resignation';
            game.updatedAt = Date.now();
            game.queuedPremoves = { white: null, black: null };

            await game.save();

            // Clear premoves
            premoveManager.clearAll(gameId, 'game_over');

            io.to(gameId).emit('game_over', {
                gameId,
                result: game.result,
                reason: 'resignation'
            });

            logger.info(`User ${socket.userId} resigned from game ${gameId}`);

        } catch (error) {
            console.error('resign_game error:', error);
            socket.emit('error', { message: error.message });
        }
    });

    // ==================== CANCEL GAME ====================
    socket.on('cancel_game', async ({ gameId }) => {
        try {
            const game = await Game.findById(gameId);

            if (!game) {
                return socket.emit('error', { message: 'Game not found' });
            }

            const isPlayer = game.whitePlayer.toString() === socket.userId ||
                game.blackPlayer.toString() === socket.userId;

            if (!isPlayer) {
                return socket.emit('error', { message: 'You are not in this game' });
            }

            if (game.status !== 'ongoing') {
                return socket.emit('error', { message: 'Game is not active' });
            }

            const chess = new Chess();
            if (game.pgn) {
                chess.loadPgn(game.pgn);
            }

            if (chess.history().length >= 2) {
                return socket.emit('error', { message: 'Cannot cancel game after first moves' });
            }

            game.status = 'completed';
            game.result = 'aborted';
            game.resultReason = 'cancelled_due_to_first_move_timeout';
            game.updatedAt = Date.now();
            game.queuedPremoves = { white: null, black: null };

            await game.save();

            // Clear premoves
            premoveManager.clearAll(gameId, 'game_over');

            io.to(gameId).emit('game_over', {
                gameId,
                result: 'aborted',
                reason: 'cancelled_due_to_first_move_timeout'
            });

            logger.info(`Game ${gameId} cancelled because first move timeout`);

        } catch (error) {
            console.error('cancel_game error:', error);
            socket.emit('error', { message: error.message });
        }
    });
}

module.exports = gameHandler;
