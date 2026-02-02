/**
 * TimeoutChecker - Background service that monitors active games for timeouts
 */

const Game = require('../models/Game');
const ClockManager = require('./ClockManager');

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
            // Find all ongoing games
            const games = await Game.find({ status: 'ongoing' });

            for (const game of games) {
                // Skip games without clock
                if (!game.clock || !game.clock.lastMoveAt) continue;

                const clock = ClockManager.fromJSON(game.clock);

                // Check first move deadline
                if (clock.isFirstMoveExpired()) {
                    await this.handleFirstMoveTimeout(game);
                    continue;
                }

                // Check regular timeout
                if (clock.isTimeout()) {
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
     * Handle first move timeout - cancel the game
     */
    async handleFirstMoveTimeout(game) {
        try {
            console.log(`⏱️  First move timeout for game ${game._id}`);

            game.status = 'cancelled_no_first_move';
            game.result = null;
            game.updatedAt = Date.now();
            await game.save();

            // Notify players
            this.io.to(game._id.toString()).emit('game_over', {
                gameId: game._id,
                result: null,
                reason: 'first_move_timeout',
                message: 'Game cancelled: White did not make first move in time'
            });

        } catch (error) {
            console.error('First move timeout handler error:', error);
        }
    }

    /**
     * Handle regular timeout - end game with winner
     */
    async handleTimeout(game, winner) {
        try {
            console.log(`⏱️  Timeout in game ${game._id}, winner: ${winner}`);

            game.status = 'completed';
            game.result = winner;
            game.updatedAt = Date.now();
            await game.save();

            // Notify players
            this.io.to(game._id.toString()).emit('game_over', {
                gameId: game._id,
                result: winner,
                reason: 'timeout',
                winner
            });

        } catch (error) {
            console.error('Timeout handler error:', error);
        }
    }
}

module.exports = TimeoutChecker;
