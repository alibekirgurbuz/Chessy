const { Chess } = require('chess.js');

// Store active AI games
const aiGames = new Map();

function aiHandler(io, socket) {

    // Start a new AI game
    socket.on('start_ai_game', (data) => {
        const { timeControl } = data;
        const gameId = 'ai_' + Math.random().toString(36).substring(2, 11);

        // Initialize chess.js instance
        const chess = new Chess();

        // Create game state
        const gameState = {
            id: gameId,
            chess: chess,
            playerColor: 'white', // Player always plays white for now
            timeControl: timeControl,
            whiteTime: timeControl.time * 60 * 1000, // Convert to ms
            blackTime: timeControl.time * 60 * 1000,
            increment: timeControl.increment * 1000, // Convert to ms
            lastMoveTime: Date.now(),
            isPlayerTurn: true,
            status: 'playing',
            moves: []
        };

        // Store game
        aiGames.set(gameId, gameState);
        socket.join(gameId);

        console.log(`🤖 [AI] New game started: ${gameId} with tempo ${timeControl.label}`);

        // Send game started event
        socket.emit('ai_game_started', {
            gameId: gameId,
            fen: chess.fen(),
            playerColor: 'white',
            timeControl: timeControl,
            whiteTime: gameState.whiteTime,
            blackTime: gameState.blackTime
        });
    });

    // Player makes a move
    socket.on('ai_move', (data) => {
        const { gameId, from, to, promotion } = data;
        const gameState = aiGames.get(gameId);

        if (!gameState) {
            socket.emit('error', { message: 'Game not found' });
            return;
        }

        if (!gameState.isPlayerTurn) {
            socket.emit('error', { message: 'Not your turn' });
            return;
        }

        const chess = gameState.chess;

        // Try to make the move
        try {
            const move = chess.move({ from, to, promotion: promotion || 'q' });

            if (!move) {
                socket.emit('error', { message: 'Invalid move' });
                return;
            }

            // Update time
            const now = Date.now();
            const elapsed = now - gameState.lastMoveTime;
            gameState.whiteTime -= elapsed;
            gameState.whiteTime += gameState.increment;
            gameState.lastMoveTime = now;
            gameState.isPlayerTurn = false;
            gameState.moves.push(move.san);

            console.log(`🎮 [AI] Player move: ${move.san}`);

            // Check for game over
            if (chess.isGameOver()) {
                handleGameOver(socket, gameState);
                return;
            }

            // Send move confirmation
            socket.emit('ai_move_made', {
                gameId: gameId,
                fen: chess.fen(),
                move: move,
                whiteTime: gameState.whiteTime,
                blackTime: gameState.blackTime,
                isPlayerTurn: false
            });

            // AI makes a move after a short delay
            const thinkTime = getAIThinkTime(gameState.timeControl);
            setTimeout(() => makeAIMove(socket, gameState), thinkTime);

        } catch (e) {
            socket.emit('error', { message: 'Invalid move: ' + e.message });
        }
    });

    // Resign game
    socket.on('ai_resign', (data) => {
        const { gameId } = data;
        const gameState = aiGames.get(gameId);

        if (gameState) {
            gameState.status = 'resigned';
            socket.emit('ai_game_over', {
                gameId: gameId,
                result: 'loss',
                reason: 'resignation'
            });
            aiGames.delete(gameId);
            console.log(`🏳️ [AI] Player resigned: ${gameId}`);
        }
    });

    // Cleanup on disconnect
    socket.on('disconnect', () => {
        // Clean up any AI games for this socket
        for (const [gameId, gameState] of aiGames.entries()) {
            // For now, just keep games alive
            // In production, set a timeout to clean up
        }
    });
}

// Calculate AI think time based on time control
function getAIThinkTime(timeControl) {
    // Faster tempo = faster AI
    const baseTime = timeControl.time;

    if (baseTime <= 2) {
        // Bullet: 200-500ms
        return 200 + Math.random() * 300;
    } else if (baseTime <= 5) {
        // Blitz: 500-1500ms
        return 500 + Math.random() * 1000;
    } else {
        // Rapid: 1000-3000ms
        return 1000 + Math.random() * 2000;
    }
}

// Make AI move (random legal move)
function makeAIMove(socket, gameState) {
    const chess = gameState.chess;

    // Get all legal moves
    const moves = chess.moves({ verbose: true });

    if (moves.length === 0) {
        handleGameOver(socket, gameState);
        return;
    }

    // Select a random move
    const randomMove = moves[Math.floor(Math.random() * moves.length)];

    // Make the move
    const move = chess.move(randomMove);

    // Update time
    const now = Date.now();
    const elapsed = now - gameState.lastMoveTime;
    gameState.blackTime -= elapsed;
    gameState.blackTime += gameState.increment;
    gameState.lastMoveTime = now;
    gameState.isPlayerTurn = true;
    gameState.moves.push(move.san);

    console.log(`🤖 [AI] AI move: ${move.san}`);

    // Check for game over
    if (chess.isGameOver()) {
        handleGameOver(socket, gameState);
        return;
    }

    // Send AI move
    socket.emit('ai_move_made', {
        gameId: gameState.id,
        fen: chess.fen(),
        move: move,
        whiteTime: gameState.whiteTime,
        blackTime: gameState.blackTime,
        isPlayerTurn: true
    });
}

// Handle game over
function handleGameOver(socket, gameState) {
    const chess = gameState.chess;
    let result, reason;

    if (chess.isCheckmate()) {
        // Whoever just moved won
        result = chess.turn() === 'w' ? 'loss' : 'win';
        reason = 'checkmate';
    } else if (chess.isDraw()) {
        result = 'draw';
        if (chess.isStalemate()) {
            reason = 'stalemate';
        } else if (chess.isThreefoldRepetition()) {
            reason = 'threefold repetition';
        } else if (chess.isInsufficientMaterial()) {
            reason = 'insufficient material';
        } else {
            reason = 'fifty-move rule';
        }
    } else {
        result = 'draw';
        reason = 'unknown';
    }

    gameState.status = 'finished';

    socket.emit('ai_game_over', {
        gameId: gameState.id,
        result: result,
        reason: reason,
        moves: gameState.moves
    });

    console.log(`🏁 [AI] Game over: ${gameState.id} - ${result} by ${reason}`);

    // Clean up
    aiGames.delete(gameState.id);
}

module.exports = aiHandler;
