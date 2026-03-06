const Game = require('../models/Game');
const { Chess } = require('chess.js');
const ClockManager = require('../services/ClockManager');
const premoveManager = require('../services/PremoveManager');
const PremoveTracer = require('../services/PremoveTracer');
const Telemetry = require('../utils/telemetry');
const logger = require('../utils/logger');
const { applyGameStats } = require('../services/StatsService');

function gameHandler(io, socket) {
    // ——— Helper: determine player color ('white'|'black') from socket.userId ———
    function getPlayerColor(game) {
        if (game.whitePlayer.toString() === socket.userId) return 'white';
        if (game.blackPlayer.toString() === socket.userId) return 'black';
        return null;
    }

    // ——— Helper: execute all valid queued premoves sequentially (called inside the lock) ———
    // Returns the final game status variables so the caller can broadcast them
    async function processPremovesUntilEmpty(game, chess, gameId, previousTraceId = null) {
        let anyExecuted = false;

        // We might loop up to 2 times (one for each player's premove)
        while (true) {
            if (game.status === 'completed' || chess.isGameOver()) break;

            const turnChar = chess.turn(); // 'w' or 'b'
            const premoveColor = turnChar === 'w' ? 'white' : 'black';
            const queuedPremove = premoveManager.getPremove(game, premoveColor);

            if (!queuedPremove) break; // No premove for current player

            const traceId = queuedPremove.traceId || previousTraceId;
            const trace = PremoveTracer.start(gameId, premoveColor, chess.history().length);
            trace.mark('turn_flipped');
            trace.mark('queued_premove_found', {
                from: queuedPremove.from,
                to: queuedPremove.to,
                promotion: queuedPremove.promotion || null
            });

            // Capture clock before
            let clockBefore = null;
            if (game.clock) {
                const tmpClock = ClockManager.fromJSON(game.clock);
                const st = tmpClock.getState();
                clockBefore = premoveColor === 'white' ? st.whiteTime : st.blackTime;
            }

            trace.mark('premove_execute_start');
            try {
                const moveResult = chess.move({
                    from: queuedPremove.from,
                    to: queuedPremove.to,
                    promotion: queuedPremove.promotion || 'q'
                });

                if (!moveResult) throw new Error('Invalid premove');

                // Clock logic
                let clockState = null;
                let clockAfter = null;
                if (game.clock) {
                    const clock = ClockManager.fromJSON(game.clock);
                    try {
                        clockState = clock.makeMove(turnChar, Date.now());
                        if (clockState.timeout) {
                            game.status = 'completed';
                            game.result = clockState.winner;
                            game.resultReason = 'timeout';
                            game.clock = clock.toJSON();
                            premoveManager.clearPremove(gameId, premoveColor, 'executed_timeout');

                            trace.mark('premove_execute_end', { outcome: 'timeout' });
                            trace.summary();
                            break; // Stop loop, game over
                        }
                        game.clock = clock.toJSON();
                        clockAfter = premoveColor === 'white' ? clockState.whiteTime : clockState.blackTime;
                    } catch (clockError) {
                        premoveManager.clearPremove(gameId, premoveColor, 'clock_error');
                        // In-memory shift first item from queue
                        if (game.queuedPremoves && Array.isArray(game.queuedPremoves[premoveColor])) {
                            game.queuedPremoves[premoveColor].shift();
                        }

                        // Send fast-rejection
                        const premovePlayerId = premoveColor === 'white' ? game.whitePlayer.toString() : game.blackPlayer.toString();
                        io.to(premovePlayerId).emit('premove_rejected', { gameId, reason: clockError.message, traceId });
                        io.to(gameId).emit('premove_cleared', { gameId, by: premoveColor, reason: 'rejected', traceId });

                        trace.mark('premove_rejected', { reason: clockError.message });
                        trace.summary();
                        break; // Stop loop, invalid
                    }
                }

                trace.mark('premove_execute_end', {
                    move: moveResult.san,
                    clock_before_ms: clockBefore,
                    clock_after_ms: clockAfter
                });

                // Update game state
                game.pgn = chess.pgn();
                game.updatedAt = Date.now();
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

                // In-memory shift: remove the first premove from queue (it was just executed)
                premoveManager.clearPremove(gameId, premoveColor, 'executed');
                if (game.queuedPremoves && Array.isArray(game.queuedPremoves[premoveColor])) {
                    game.queuedPremoves[premoveColor].shift();
                }
                anyExecuted = true;

                // Fire broadcasrts immediately for this hop
                trace.mark('premove_broadcast_start');
                io.to(gameId).emit('move_made', {
                    gameId,
                    move: moveResult.san,
                    from: moveResult.from,
                    to: moveResult.to,
                    pgn: game.pgn,
                    currentTurn: chess.turn(),
                    fen: chess.fen(),
                    moveCount: chess.history().length,
                    traceId
                });

                if (clockState) {
                    io.to(gameId).emit('clock_update', { ...clockState, traceId });
                }

                io.to(gameId).emit('premove_cleared', { gameId, by: premoveColor, reason: 'executed', traceId });

                if (game.status === 'completed') {
                    io.to(gameId).emit('game_over', {
                        gameId,
                        result: game.result,
                        reason: game.resultReason
                    });
                    premoveManager.clearAll(gameId, 'game_over');
                    applyGameStats(gameId);
                }

                trace.mark('premove_broadcast_end');
                trace.summary();

                // Wait a tiny bit (optional) or continue loop seamlessly
            } catch (e) {
                // Invalid or failed premove — clear the entire queue for that color
                premoveManager.clearPremove(gameId, premoveColor, 'rejected');
                if (game.queuedPremoves && Array.isArray(game.queuedPremoves[premoveColor])) {
                    game.queuedPremoves[premoveColor] = [];
                }

                const premovePlayerId = premoveColor === 'white' ? game.whitePlayer.toString() : game.blackPlayer.toString();
                io.to(premovePlayerId).emit('premove_rejected', { gameId, reason: e.message || 'Invalid premove', traceId });
                io.to(gameId).emit('premove_cleared', { gameId, by: premoveColor, reason: 'rejected', traceId });

                trace.mark('premove_rejected', { reason: e.message });
                trace.summary();
                break;
            }
        }

        return anyExecuted;
    }



    // ==================== JOIN GAME ====================
    socket.on('join_game', async ({ gameId, traceId }, ack) => {
        if (traceId) {
            Telemetry.log({ traceId, gameId, userId: socket.userId, event: 'join_game_received' });
        }
        let ackSent = false;
        const sendAck = () => {
            if (!ackSent && typeof ack === 'function') {
                ack();
                ackSent = true;
            }
        };
        try {
            const game = await Game.findById(gameId);

            if (!game) {
                return socket.emit('error', { message: 'Game not found' });
            }

            // Fast-ack receipt after minimal validation (game exists).
            sendAck();

            // Socket'i oyun odasına ekle
            socket.join(gameId);

            // Cancel pending disconnect timeout atomically if this same user was marked disconnected.
            // Using updateOne avoids stale-document races during rapid refresh reconnects.
            const reconnectClearResult = await Game.updateOne(
                {
                    _id: gameId,
                    disconnectedPlayerId: socket.userId,
                    status: 'ongoing'
                },
                {
                    $set: {
                        disconnectedPlayerId: null,
                        disconnectDeadlineAt: null,
                    }
                }
            );

            if (reconnectClearResult.modifiedCount > 0) {
                // Determine the original deadline to clear it locally (or just signal player reconnected)
                io.to(gameId).emit('opponent_reconnected', { playerId: socket.userId, gameId: gameId });
                logger.info(`[Socket] User ${socket.userId} reconnected to game ${gameId}, cancelled disconnect timeout.`);
            } else if (game.status === 'ongoing' && game.disconnectedPlayerId === socket.userId) {
                // Edge case: In case game object fetched earlier differs from what DB has, but still we didn't modify
                // This shouldn't normally happen with atomic updates, but just loop back.
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

            // Only query DB for registered users (i.e. those not starting with 'guest_')
            const userIdsToFetch = [whiteId, blackId].filter(id => !id.startsWith('guest_'));

            let players = [];
            if (userIdsToFetch.length > 0) {
                try {
                    players = await User.find({ clerkId: { $in: userIdsToFetch } });
                } catch (err) {
                    console.error('Error fetching users in join_game:', err);
                }
            }

            const whiteUser = players.find(p => p.clerkId === whiteId);
            const blackUser = players.find(p => p.clerkId === blackId);

            const getDisplayName = (user, id) => {
                if (user) {
                    return user.username || user.firstName || user.displayName || 'Oyuncu';
                }
                return id.startsWith('guest_') ? 'Misafir Oyuncu' : 'Oyuncu';
            };

            let isWhiteSocketOnline = false;
            let isBlackSocketOnline = false;
            try {
                isWhiteSocketOnline = (await io.in(whiteId).fetchSockets()).length > 0;
                isBlackSocketOnline = (await io.in(blackId).fetchSockets()).length > 0;

                // Fallback: Check overall connected sockets if room join was delayed
                if (!isWhiteSocketOnline || !isBlackSocketOnline) {
                    const allSockets = await io.fetchSockets();
                    if (!isWhiteSocketOnline) {
                        isWhiteSocketOnline = allSockets.some(s => s.userId === whiteId);
                    }
                    if (!isBlackSocketOnline) {
                        isBlackSocketOnline = allSockets.some(s => s.userId === blackId);
                    }
                }
            } catch (err) {
                logger.warn('Error checking online sockets:', err);
            }

            const whitePlayerInfo = {
                _id: whiteId,
                username: getDisplayName(whiteUser, whiteId),
                isGuest: whiteId.startsWith('guest_'),
                isOnline: (whiteUser && whiteUser.isOnline) || isWhiteSocketOnline || false
            };

            const blackPlayerInfo = {
                _id: blackId,
                username: getDisplayName(blackUser, blackId),
                isGuest: blackId.startsWith('guest_'),
                isOnline: (blackUser && blackUser.isOnline) || isBlackSocketOnline || false
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
                },
                traceId
            });

            if (traceId) {
                Telemetry.log({ traceId, gameId, userId: socket.userId, event: 'join_game_response' });
            }

            // Send initial clock update
            if (game.clock) {
                const clock = ClockManager.fromJSON(game.clock);
                const clockState = clock.getState();
                socket.emit('clock_update', clockState);
                io.to(gameId).emit('clock_update', clockState);
            }

            // Rehydrate premoves from DB into in-memory manager
            if (game.queuedPremoves) {
                premoveManager.rehydrate(gameId, game.queuedPremoves);
            }

            logger.info(`🎮 User ${socket.userId} joined game ${gameId} | Socket: ${socket.id} | FEN: ${chess.fen()}`);

        } catch (error) {
            console.error('join_game error:', error);
            socket.emit('error', { message: error.message });
        }
    });

    // ==================== MAKE MOVE (with premove auto-execute) ====================
    socket.on('make_move', async ({ gameId, move, clientTimestamp, traceId }, ack) => {
        if (traceId) {
            Telemetry.log({ traceId, gameId, userId: socket.userId, event: 'make_move_received' });
        }

        let ackSent = false;
        const sendAck = () => {
            if (!ackSent && typeof ack === 'function') {
                ack();
                ackSent = true;
                if (traceId) Telemetry.log({ traceId, gameId, userId: socket.userId, event: 'make_move_ack_sent' });
            }
        };

        // 1. Pre-lock lightweight checks
        if (!move || typeof move !== 'object' || !move.from || !move.to) {
            return socket.emit('error', { message: 'Invalid move data' });
        }

        // Fast-ack on receipt to avoid lock queue and DB read latency in callback RTT.
        sendAck();

        const lockStart = Date.now();
        let lockAcquired = 0;

        // Variables for background processing (Must stay in outer-scope for post-lock pipeline. Do NOT shadow with 'let' inside the lock)
        let moveDbUpdate = null;
        let isGameOver = false;
        let clockState = null;
        let updatedPgn = null;
        let moveResultSan = null;
        let moveResultFrom = null;
        let moveResultTo = null;
        let currentTurn = null;
        let fen = null;
        let moveCount = null;
        let gameRef = null;
        let chessRef = null;

        try {
            await premoveManager.withLock(gameId, async () => {
                lockAcquired = Date.now();
                if (traceId) {
                    Telemetry.log({ traceId, gameId, event: 'lock_acquired', meta: { lock_wait_ms: lockAcquired - lockStart, type: 'make_move' } });
                }

                try {
                    // DB read must be inside lock to prevent Lost Updates on concurrent moves
                    let game = await Game.findById(gameId).select('+pgn +clock +whitePlayer +blackPlayer +status +result').lean();
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
                        logger.warn(`🚫 Invalid move attempt by ${socket.userId} in ${gameId} | Move: ${JSON.stringify(move)} | Socket: ${socket.id}`);
                        return socket.emit('error', { message: 'Invalid move' });
                    }

                    if (traceId) {
                        Telemetry.log({ traceId, gameId, userId: socket.userId, event: 'make_move_validated' });
                    }

                    logger.info(`♟️ Move made: ${moveResult.san} by ${socket.userId} in ${gameId} | Socket: ${socket.id}`);

                    // Clear the mover's own premove if they had one (they played a normal move instead)
                    const moverColor = isWhitePlayer ? 'white' : 'black';
                    if (premoveManager.getPremove(game, moverColor)) {
                        premoveManager.clearPremove(gameId, moverColor, 'normal_move_override');
                        if (!game.queuedPremoves) game.queuedPremoves = {};
                        game.queuedPremoves[moverColor] = null;
                        io.to(gameId).emit('premove_cleared', {
                            gameId,
                            by: moverColor,
                            reason: 'cancelled'
                        });
                    }

                    logger.info(`[DEBUG] About to enter clock logic. gameId=${gameId}, moveResult=${moveResult.san}`);

                    // ========== CLOCK LOGIC START ==========
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

                            if (clockState.timeout) {
                                game.status = 'completed';
                                game.result = clockState.winner;
                                game.clock = clock.toJSON();
                                // We will persist this using updateOne later, skip save() here to avoid blocking

                                io.to(gameId).emit('game_over', {
                                    gameId,
                                    result: clockState.winner,
                                    reason: 'timeout'
                                });
                                io.to(gameId).emit('clock_update', clockState);
                                premoveManager.clearAll(gameId, 'game_over');
                                // DO NOT return here, let it fall through to the DB persist at the end!
                                isGameOver = true;
                            } else {
                                game.clock = clock.toJSON();
                            }

                        } catch (clockError) {
                            console.error('[DEBUG] Clock error in make_move!!!', clockError);
                            return socket.emit('error', { message: clockError.message });
                        }
                    }
                    // ========== CLOCK LOGIC END ==========

                    logger.info(`[DEBUG] Clock logic passed! Updating PGN and status...`);

                    updatedPgn = chess.pgn();
                    const updatedAt = Date.now();
                    game.pgn = updatedPgn;
                    game.updatedAt = updatedAt;

                    // Mat/beraberlik kontrolü
                    // Check if game was already marked over by timeout
                    if (!isGameOver && chess.isGameOver()) {
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

                    // Prepare DB Payload for the normal move
                    moveDbUpdate = {
                        pgn: updatedPgn,
                        updatedAt,
                    };
                    if (game.clock) moveDbUpdate.clock = game.clock;
                    if (moverColor && premoveManager.getPremove(game, moverColor) === null) {
                        moveDbUpdate[`queuedPremoves.${moverColor}`] = null;
                        if (!game.queuedPremoves) game.queuedPremoves = {};
                        game.queuedPremoves[moverColor] = null;
                    }
                    if (isGameOver) {
                        moveDbUpdate.status = game.status;
                        moveDbUpdate.result = game.result;
                        moveDbUpdate.resultReason = game.resultReason;
                    }

                    // Process cascaded premoves modifying the game object in memory
                    if (!isGameOver) {
                        await processPremovesUntilEmpty(game, chess, gameId, traceId);

                        // Overwrite moveDbUpdate with the final aggregated state from all premoves
                        moveDbUpdate.pgn = game.pgn;
                        moveDbUpdate.updatedAt = game.updatedAt;
                        if (game.clock) moveDbUpdate.clock = game.clock;
                        if (game.status === 'completed') {
                            isGameOver = true;
                            moveDbUpdate.status = game.status;
                            moveDbUpdate.result = game.result;
                            moveDbUpdate.resultReason = game.resultReason;
                        }

                        // Mirror the updated premove queues (arrays)
                        moveDbUpdate['queuedPremoves.white'] = Array.isArray(game.queuedPremoves?.white)
                            ? game.queuedPremoves.white
                            : [];
                        moveDbUpdate['queuedPremoves.black'] = Array.isArray(game.queuedPremoves?.black)
                            ? game.queuedPremoves.black
                            : [];
                    }

                    // Save refs for background broadcast (of the primary move only, premove broadcast handled locally)
                    moveResultSan = moveResult.san;
                    moveResultFrom = moveResult.from;
                    moveResultTo = moveResult.to;
                    currentTurn = chess.turn();
                    fen = chess.fen();
                    moveCount = chess.history().length;
                    gameRef = game;
                    chessRef = chess;

                    // PERSIST TO DB SYNCHRONOUSLY INSIDE THE LOCK 
                    // This is the core fix to prevent set_premove concurrency overwrite
                    if (traceId) Telemetry.log({ traceId, gameId, event: 'make_move_persist_start' });
                    const persistStart = Date.now();
                    await Game.updateOne({ _id: gameId }, { $set: moveDbUpdate });
                    if (traceId) Telemetry.log({ traceId, gameId, event: 'make_move_persist_end', latencyMs: Date.now() - persistStart });

                } catch (error) {
                    console.error('make_move inside-lock error:', error);
                    socket.emit('error', { message: error.message });
                }
            });
            if (traceId) Telemetry.log({ traceId, gameId, event: 'lock_released', meta: { lock_hold_ms: Date.now() - lockStart } });

            // ── OUTSIDE LOCK: Broadcast Primary Move ──
            if (moveDbUpdate && gameRef) {
                // Background Broadcast (primary move)
                io.to(gameId).emit('move_made', {
                    gameId,
                    move: moveResultSan,
                    from: moveResultFrom,
                    to: moveResultTo,
                    pgn: updatedPgn,
                    currentTurn,
                    fen,
                    moveCount,
                    traceId
                });

                if (clockState) {
                    io.to(gameId).emit('clock_update', { ...clockState, traceId });
                    if (traceId) Telemetry.log({ traceId, gameId, userId: socket.userId, event: 'clock_update_emit' });
                }

                if (traceId) Telemetry.log({ traceId, gameId, userId: socket.userId, event: 'make_move_broadcast' });

                if (isGameOver && gameRef.status === 'completed') {
                    io.to(gameId).emit('game_over', {
                        gameId,
                        result: gameRef.result,
                        reason: gameRef.resultReason || 'checkmate'
                    });
                    premoveManager.clearAll(gameId, 'game_over');
                    applyGameStats(gameId).catch(err => logger.error('applyGameStats err:', err));
                }
            }

        } catch (error) {
            console.error('make_move outer lock error:', error);
            socket.emit('error', { message: error.message || 'System busy. Please try again.' });
        }
    });

    // ==================== SET PREMOVE ====================
    socket.on('set_premove', async ({ gameId, premove, traceId }, ack) => {
        if (traceId) {
            Telemetry.log({ traceId, gameId, userId: socket.userId, event: 'set_premove_received' });
        }
        logger.debug('[PREMOVE_DIAG] set_premove_received', { gameId, socketId: socket.id, userId: socket.userId, premove });

        let ackSent = false;
        const sendAck = () => {
            if (!ackSent && typeof ack === 'function') {
                ack();
                ackSent = true;
                if (traceId) Telemetry.log({ traceId, gameId, userId: socket.userId, event: 'set_premove_ack_sent' });
            }
        };

        // 1. Pre-lock lightweight checks
        if (!premove || typeof premove !== 'object' || !premove.from || !premove.to) {
            logger.debug('[PREMOVE_DIAG] set_premove_rejected_diag', { gameId, reason: 'Invalid premove data format' });
            return socket.emit('premove_rejected', {
                gameId,
                reason: 'Invalid premove data',
                traceId
            });
        }

        // Fast-ack on receipt to avoid lock queue and DB read latency in callback RTT.
        sendAck();

        const lockStart = Date.now();
        let dbPersistData = null; // Used to persist outside lock
        let playerColorRef = null;
        let lockAcquired = 0;

        try {
            await premoveManager.withLock(gameId, async () => {
                lockAcquired = Date.now();
                if (traceId) Telemetry.log({ traceId, gameId, event: 'lock_acquired', meta: { lock_wait_ms: lockAcquired - lockStart, type: 'set_premove' } });

                try {
                    // DB read inside lock to prevent race conditions
                    let game = await Game.findById(gameId).select('+pgn +whitePlayer +blackPlayer +status').lean();
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
                    logger.debug('[PREMOVE_DIAG] set_premove_turn_check', { gameId, playerColor, currentTurnColor, isPlayersTurn: currentTurnColor === playerColor });

                    let lateAcceptance = false;
                    if (currentTurnColor === playerColor) {
                        logger.debug('[PREMOVE_DIAG] set_premove_late_acceptance', { gameId, playerColor });
                        lateAcceptance = true;
                    }

                    // Store premove (overwrites any existing) - Memory Only inside lock
                    const setAt = Date.now();
                    const sourceMoveNo = chess.history().length;

                    if (traceId) Telemetry.log({ traceId, gameId, userId: socket.userId, event: 'set_premove_validated' });

                    const queuedData = {
                        from: premove.from,
                        to: premove.to,
                        promotion: premove.promotion || undefined,
                        setAt,
                        sourceMoveNo,
                        traceId
                    };

                    premoveManager.setPremove(gameId, playerColor, queuedData);

                    // Attach to game object in memory for DB persist AND cascade read
                    // Push to array queue (max 2 slots); reject if already full
                    if (!game.queuedPremoves) game.queuedPremoves = {};
                    if (!Array.isArray(game.queuedPremoves[playerColor])) {
                        game.queuedPremoves[playerColor] = [];
                    }

                    if (game.queuedPremoves[playerColor].length >= 2) {
                        // Queue full — reject silently (client can show no-op feedback)
                        logger.debug('[PREMOVE_DIAG] set_premove_queue_full', { gameId, playerColor });
                        return socket.emit('premove_rejected', {
                            gameId,
                            reason: 'Premove queue is full (max 2)',
                            traceId
                        });
                    }

                    game.queuedPremoves[playerColor].push(queuedData);

                    dbPersistData = queuedData;
                    playerColorRef = playerColor;

                    if (lateAcceptance) {
                        // The user's turn actually arrived before or exactly as the packet hit the lock.
                        // We will consume it right here via cascade processing inside the same lock!
                        await processPremovesUntilEmpty(game, chess, gameId, traceId);
                    }

                    // SYNCHRONOUS DB PERSIST INSIDE THE LOCK
                    if (traceId) Telemetry.log({ traceId, gameId, event: 'set_premove_persist_start' });
                    const persistStart = Date.now();

                    // Only update the queuedPremoves field, unless lateAcceptance executed it 
                    // which modifies PGN, Clock, Status etc.
                    const updatePayload = {};
                    if (lateAcceptance) {
                        updatePayload.pgn = game.pgn;
                        updatePayload.updatedAt = game.updatedAt;
                        if (game.clock) updatePayload.clock = game.clock;
                        if (game.status === 'completed') {
                            updatePayload.status = game.status;
                            updatePayload.result = game.result;
                            updatePayload.resultReason = game.resultReason;
                        }
                        updatePayload['queuedPremoves.white'] = Array.isArray(game.queuedPremoves?.white)
                            ? game.queuedPremoves.white
                            : [];
                        updatePayload['queuedPremoves.black'] = Array.isArray(game.queuedPremoves?.black)
                            ? game.queuedPremoves.black
                            : [];
                    } else {
                        // Push newly queued premove at correct array index in DB
                        updatePayload[`queuedPremoves.${playerColor}`] = game.queuedPremoves[playerColor];
                    }

                    await Game.updateOne(
                        { _id: gameId },
                        { $set: updatePayload }
                    );
                    if (traceId) Telemetry.log({ traceId, gameId, event: 'set_premove_persist_end', latencyMs: Date.now() - persistStart });

                } catch (error) {
                    console.error('set_premove error:', error);
                    socket.emit('error', { message: error.message });
                }
            });
            if (traceId) Telemetry.log({ traceId, gameId, event: 'lock_released', meta: { lock_hold_ms: Date.now() - lockStart } });

            // ── OUTSIDE LOCK: Broadcast Initial Queue Setup ──
            if (dbPersistData && playerColorRef) {
                io.to(gameId).emit('premove_set', {
                    gameId,
                    by: playerColorRef,
                    premove: { from: premove.from, to: premove.to, promotion: premove.promotion },
                    traceId
                });
            }
        } catch (error) {
            console.error('set_premove outer lock error:', error);
            socket.emit('error', { message: error.message || 'System busy. Please try again.' });
        }
    });

    // ==================== CANCEL PREMOVE ====================
    socket.on('cancel_premove', async ({ gameId }) => {
        try {
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

                    // Clear entire premove queue for this player
                    premoveManager.clearPremove(gameId, playerColor, 'cancelled');

                    // Persist: set queue to empty array
                    await Game.updateOne(
                        { _id: gameId },
                        { $set: { [`queuedPremoves.${playerColor}`]: [] } }
                    );

                    // Notify room and user
                    io.to(gameId).emit('premove_cleared', { gameId, by: playerColor, reason: 'cancelled' });
                    socket.emit('premove_cleared', { gameId, by: playerColor, reason: 'cancelled' });

                } catch (error) {
                    console.error('cancel_premove error inside lock:', error);
                    socket.emit('error', { message: error.message });
                }
            });
        } catch (error) {
            console.error('cancel_premove lock error:', error);
            socket.emit('error', { message: 'Sistem meşgul, lütfen tekrar deneyin.' });
        }
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
            game.pendingDrawOfferFrom = null; // Clear pending draw offer on resign

            await game.save();

            // Clear premoves
            premoveManager.clearAll(gameId, 'game_over');
            applyGameStats(gameId);

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

    // ==================== DRAW OFFERS ====================
    socket.on('offer_draw', async ({ gameId }) => {
        try {
            const game = await Game.findById(gameId);

            if (!game) return socket.emit('error', { message: 'Game not found' });

            const isWhitePlayer = game.whitePlayer.toString() === socket.userId;
            const isBlackPlayer = game.blackPlayer.toString() === socket.userId;

            if (!isWhitePlayer && !isBlackPlayer) {
                return socket.emit('error', { message: 'You are not in this game' });
            }

            if (game.status !== 'ongoing') {
                return socket.emit('error', { message: 'Game is not active' });
            }

            const playerColor = isWhitePlayer ? 'white' : 'black';
            const opponentId = isWhitePlayer ? game.blackPlayer.toString() : game.whitePlayer.toString();

            // Check limits (max 2 offers per player per game)
            const currentOffers = playerColor === 'white' ? game.whiteDrawOffers : game.blackDrawOffers;
            if (currentOffers >= 2) {
                return socket.emit('error', { message: 'Maximum draw offers reached for you in this game' });
            }

            // Check if there is already a pending offer
            if (game.pendingDrawOfferFrom) {
                return socket.emit('error', { message: 'A draw offer is already pending' });
            }

            // Update state
            game.pendingDrawOfferFrom = playerColor;
            if (playerColor === 'white') {
                game.whiteDrawOffers += 1;
            } else {
                game.blackDrawOffers += 1;
            }
            await game.save();

            // Send to opponent
            socket.to(opponentId).emit('draw_offered', {
                gameId,
                by: playerColor
            });

            // Also emit to the same user's other sessions (e.g. mobile/web simultaneously open)
            // so UI can update to show they offered a draw.
            io.to(socket.userId).emit('draw_offered', {
                gameId,
                by: playerColor
            });

            logger.info(`User ${socket.userId} (${playerColor}) offered a draw in game ${gameId}`);

        } catch (error) {
            console.error('offer_draw error:', error);
            socket.emit('error', { message: error.message });
        }
    });

    socket.on('accept_draw', async ({ gameId }) => {
        try {
            const game = await Game.findById(gameId);

            if (!game) return socket.emit('error', { message: 'Game not found' });

            const isWhitePlayer = game.whitePlayer.toString() === socket.userId;
            const isBlackPlayer = game.blackPlayer.toString() === socket.userId;

            if (!isWhitePlayer && !isBlackPlayer) {
                return socket.emit('error', { message: 'You are not in this game' });
            }

            if (game.status !== 'ongoing') {
                return socket.emit('error', { message: 'Game is not active' });
            }

            const playerColor = isWhitePlayer ? 'white' : 'black';

            // Validate there is a pending offer, and it's NOT from the accepting player
            if (!game.pendingDrawOfferFrom) {
                return socket.emit('error', { message: 'No pending draw offer to accept' });
            }

            if (game.pendingDrawOfferFrom === playerColor) {
                return socket.emit('error', { message: 'You cannot accept your own draw offer' });
            }

            // End the game
            game.status = 'completed';
            game.result = 'draw';
            game.resultReason = 'draw_agreed';
            game.updatedAt = Date.now();
            game.queuedPremoves = { white: null, black: null };
            game.pendingDrawOfferFrom = null;

            await game.save();

            premoveManager.clearAll(gameId, 'game_over');
            applyGameStats(gameId);

            io.to(gameId).emit('game_over', {
                gameId,
                result: 'draw',
                reason: 'draw_agreed'
            });

            logger.info(`User ${socket.userId} accepted draw in game ${gameId}`);

        } catch (error) {
            console.error('accept_draw error:', error);
            socket.emit('error', { message: error.message });
        }
    });

    socket.on('reject_draw', async ({ gameId }) => {
        try {
            const game = await Game.findById(gameId);

            if (!game) return socket.emit('error', { message: 'Game not found' });

            const isWhitePlayer = game.whitePlayer.toString() === socket.userId;
            const isBlackPlayer = game.blackPlayer.toString() === socket.userId;

            if (!isWhitePlayer && !isBlackPlayer) {
                return socket.emit('error', { message: 'You are not in this game' });
            }

            if (game.status !== 'ongoing') {
                return socket.emit('error', { message: 'Game is not active' });
            }

            const playerColor = isWhitePlayer ? 'white' : 'black';
            const opponentId = isWhitePlayer ? game.blackPlayer.toString() : game.whitePlayer.toString();

            // Validate there is a pending offer from the opponent
            if (game.pendingDrawOfferFrom !== (playerColor === 'white' ? 'black' : 'white')) {
                return socket.emit('error', { message: 'No valid pending draw offer to reject' });
            }

            game.pendingDrawOfferFrom = null;
            await game.save();

            // Emit rejection to both players so UI un-blocks
            io.to(gameId).emit('draw_rejected', {
                gameId,
                by: playerColor
            });

            logger.info(`User ${socket.userId} rejected draw in game ${gameId}`);

        } catch (error) {
            console.error('reject_draw error:', error);
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
    // ==================== REMATCH OFFERS ====================
    socket.on('offer_rematch', async ({ gameId }) => {
        try {
            const game = await Game.findById(gameId);
            if (!game) return socket.emit('error', { message: 'Game not found' });

            const isWhitePlayer = game.whitePlayer.toString() === socket.userId;
            const isBlackPlayer = game.blackPlayer.toString() === socket.userId;

            if (!isWhitePlayer && !isBlackPlayer) {
                return socket.emit('error', { message: 'You are not in this game' });
            }

            if (game.status !== 'completed') {
                return socket.emit('error', { message: 'Rematch is only available after the game is completed' });
            }

            if (game.rematchDeclined) {
                return socket.emit('error', { message: 'Rematch has already been declined' });
            }

            if (game.rematchOfferFrom) {
                return socket.emit('error', { message: 'A rematch offer is already pending' });
            }

            if (game.nextGameId) {
                return socket.emit('error', { message: 'A rematch has already been accepted' });
            }

            const playerColor = isWhitePlayer ? 'white' : 'black';
            const opponentId = isWhitePlayer ? game.blackPlayer.toString() : game.whitePlayer.toString();

            // Update state
            game.rematchOfferFrom = playerColor;
            await game.save();

            // Send to opponent
            socket.to(opponentId).emit('rematch_offered', {
                gameId,
                by: playerColor
            });

            // Emit to same user
            io.to(socket.userId).emit('rematch_offered', {
                gameId,
                by: playerColor
            });

            logger.info(`User ${socket.userId} (${playerColor}) offered a rematch in game ${gameId}`);

        } catch (error) {
            console.error('offer_rematch error:', error);
            socket.emit('error', { message: error.message });
        }
    });

    socket.on('accept_rematch', async ({ gameId }) => {
        try {
            const game = await Game.findById(gameId);
            if (!game) return socket.emit('error', { message: 'Game not found' });

            const isWhitePlayer = game.whitePlayer.toString() === socket.userId;
            const isBlackPlayer = game.blackPlayer.toString() === socket.userId;

            if (!isWhitePlayer && !isBlackPlayer) {
                return socket.emit('error', { message: 'You are not in this game' });
            }

            if (game.status !== 'completed') {
                return socket.emit('error', { message: 'Rematch is only available after the game is completed' });
            }

            const playerColor = isWhitePlayer ? 'white' : 'black';

            if (!game.rematchOfferFrom) {
                return socket.emit('error', { message: 'No pending rematch offer to accept' });
            }

            if (game.rematchOfferFrom === playerColor) {
                return socket.emit('error', { message: 'You cannot accept your own rematch offer' });
            }

            if (game.nextGameId) {
                // If double clicked, or somehow handled twice, avoid duplicate game creation
                return;
            }

            // Create new game (swapping colors from the old game)
            // Old White -> New Black
            // Old Black -> New White
            const newWhitePlayerId = game.blackPlayer.toString();
            const newBlackPlayerId = game.whitePlayer.toString();

            const baseTime = game.timeControl.time * 60 * 1000;
            const increment = game.timeControl.increment * 1000;

            const newGame = new Game({
                whitePlayer: newWhitePlayerId,
                blackPlayer: newBlackPlayerId,
                pgn: '',
                status: 'ongoing',
                timeControl: {
                    time: game.timeControl.time,
                    increment: game.timeControl.increment,
                    label: game.timeControl.label
                },
                clock: {
                    whiteTime: baseTime,
                    blackTime: baseTime,
                    activeColor: null,
                    lastMoveAt: null,
                    firstMoveDeadline: Date.now() + 30000,
                    moveCount: 0,
                    baseTime: baseTime,
                    increment: increment
                }
            });

            await newGame.save();

            // Store ref on the old game
            game.nextGameId = newGame._id.toString();
            game.rematchOfferFrom = null; // Clear offer state
            await game.save();

            // Broadcast acceptance to both players in the old room
            io.to(gameId).emit('rematch_accepted', {
                gameId,
                newGameId: newGame._id.toString()
            });

            logger.info(`User ${socket.userId} accepted rematch for game ${gameId}. New game: ${newGame._id}`);

        } catch (error) {
            console.error('accept_rematch error:', error);
            socket.emit('error', { message: error.message });
        }
    });

    socket.on('reject_rematch', async ({ gameId }) => {
        try {
            const game = await Game.findById(gameId);
            if (!game) return socket.emit('error', { message: 'Game not found' });

            const isWhitePlayer = game.whitePlayer.toString() === socket.userId;
            const isBlackPlayer = game.blackPlayer.toString() === socket.userId;

            if (!isWhitePlayer && !isBlackPlayer) {
                return socket.emit('error', { message: 'You are not in this game' });
            }

            if (game.status !== 'completed') {
                return socket.emit('error', { message: 'Game is not completed' });
            }

            const playerColor = isWhitePlayer ? 'white' : 'black';

            // Validate there is a pending offer from the opponent
            if (game.rematchOfferFrom !== (playerColor === 'white' ? 'black' : 'white')) {
                return socket.emit('error', { message: 'No valid pending rematch offer to reject' });
            }

            // Set state to declined so no more offers can be made
            game.rematchDeclined = true;
            game.rematchOfferFrom = null;
            await game.save();

            // Emit rejection to both players
            io.to(gameId).emit('rematch_rejected', {
                gameId,
                by: playerColor
            });

            logger.info(`User ${socket.userId} rejected rematch in game ${gameId}`);

        } catch (error) {
            console.error('reject_rematch error:', error);
            socket.emit('error', { message: error.message });
        }
    });
}

module.exports = gameHandler;
