/**
 * TimeoutChecker - Background service that monitors active games for timeouts
 */

const Game = require('../models/Game');
const ClockManager = require('./ClockManager');
const { applyGameStats } = require('./StatsService');

class TimeoutChecker {
    constructor(io) {
        this.io = io;
        this.interval = null;
        this.CHECK_INTERVAL = 100; // Check every 100ms for precision
    }

    /**
     * Start the timeout checker
     */
    start() {
        if (this.interval) {
            console.warn('TimeoutChecker already running');
            return;
        }

        console.log('⏱️  TimeoutChecker started');

        this.interval = setInterval(() => {
            this.checkTimeouts();
        }, this.CHECK_INTERVAL);
    }

    /**
     * Stop the timeout checker
     */
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            console.log('⏱️  TimeoutChecker stopped');
        }
    }

    /**
     * Check all ongoing games for timeouts and first move deadlines
     */
    async checkTimeouts() {
        try {
            // Find all ongoing games with a clock or a pending disconnect deadline
            const games = await Game.find({
                status: 'ongoing',
                $or: [
                    { clock: { $ne: null } },
                    { disconnectDeadlineAt: { $ne: null } }
                ]
            });

            for (const game of games) {
                // 1) Check disconnect deadline FIRST
                if (game.disconnectDeadlineAt && Date.now() >= game.disconnectDeadlineAt) {
                    const winner = game.disconnectedPlayerId === game.whitePlayer.toString() ? 'black' : 'white';
                    await this.handleDisconnectTimeout(game, winner);
                    continue; // Skip clock checks if game is forfeit
                }

                if (!game.clock) continue;

                const clock = ClockManager.fromJSON(game.clock);

                // 2) Check first-move deadline (does NOT require lastMoveAt)
                if (clock.isFirstMoveExpired()) {
                    await this.handleFirstMoveTimeout(game);
                    continue;
                }

                // 3) Check regular timeout (requires active clock with lastMoveAt)
                if (clock.lastMoveAt && clock.isTimeout()) {
                    const times = clock.getCurrentTime();
                    const winner = times.whiteTime <= 0 ? 'black' : 'white';
                    await this.handleTimeout(game, winner);
                }
            }
        } catch (error) {
            console.error('TimeoutChecker error:', error);
        }
    }

    /**
     * Handle first move timeout - abort the game
     * Uses status='completed', result='aborted', reason='cancelled_due_to_first_move_timeout'
     */
    async handleFirstMoveTimeout(game) {
        try {
            // Guard: re-check status to prevent duplicate termination from concurrent ticks
            const freshGame = await Game.findById(game._id);
            if (!freshGame || freshGame.status !== 'ongoing') return;

            console.log(`⏱️  First move timeout for game ${game._id}`);

            freshGame.status = 'completed';
            freshGame.result = 'aborted';
            freshGame.resultReason = 'cancelled_due_to_first_move_timeout';
            freshGame.updatedAt = Date.now();
            await freshGame.save();

            // Notify players — aligned to GameOverPayload
            this.io.to(game._id.toString()).emit('game_over', {
                gameId: game._id,
                result: 'aborted',
                reason: 'cancelled_due_to_first_move_timeout'
            });

        } catch (error) {
            console.error('First move timeout handler error:', error);
        }
    }

    /**
     * Handle regular timeout - end game with winner
     * Uses status='completed', result=winner, reason='timeout'
     */
    async handleTimeout(game, winner) {
        try {
            // Guard: re-check status to prevent duplicate termination from concurrent ticks
            const freshGame = await Game.findById(game._id);
            if (!freshGame || freshGame.status !== 'ongoing') return;

            console.log(`⏱️  Timeout in game ${game._id}, winner: ${winner}`);

            freshGame.status = 'completed';
            freshGame.result = winner;
            freshGame.resultReason = 'timeout';
            freshGame.updatedAt = Date.now();
            await freshGame.save();
            await applyGameStats(freshGame._id);

            // Notify players — aligned to GameOverPayload
            this.io.to(game._id.toString()).emit('game_over', {
                gameId: game._id,
                result: winner,
                reason: 'timeout'
            });

        } catch (error) {
            console.error('Timeout handler error:', error);
        }
    }

    /**
     * Handle disconnect timeout - end game with winner
     * Uses status='completed', result=winner, reason='disconnect_timeout'
     */
    async handleDisconnectTimeout(game, winner) {
        try {
            // Guard: re-check status to prevent duplicate termination from concurrent ticks
            const freshGame = await Game.findById(game._id);
            if (!freshGame || freshGame.status !== 'ongoing') return;

            console.log(`⏱️  Disconnect timeout in game ${game._id}, winner: ${winner}`);

            freshGame.status = 'completed';
            freshGame.result = winner;
            freshGame.resultReason = 'disconnect_timeout';

            // Clear pending disconnection fields
            freshGame.disconnectedPlayerId = null;
            freshGame.disconnectDeadlineAt = null;

            freshGame.updatedAt = Date.now();
            await freshGame.save();
            await applyGameStats(freshGame._id);

            // Notify players — aligned to GameOverPayload
            this.io.to(game._id.toString()).emit('game_over', {
                gameId: game._id,
                result: winner,
                reason: 'disconnect_timeout'
            });

        } catch (error) {
            console.error('Disconnect timeout handler error:', error);
        }
    }
}

module.exports = TimeoutChecker;
