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
                    // Safety net:
                    // If the supposedly disconnected player already has an active socket again,
                    // clear stale disconnect marker instead of forfeiting the game.
                    if (game.disconnectedPlayerId) {
                        const sockets = await this.io.in(game.disconnectedPlayerId).fetchSockets();
                        if (sockets.length > 0) {
                            await Game.updateOne(
                                { _id: game._id, disconnectedPlayerId: game.disconnectedPlayerId },
                                {
                                    $set: {
                                        disconnectedPlayerId: null,
                                        disconnectDeadlineAt: null,
                                    }
                                }
                            );
                            this.io.to(game._id.toString()).emit('opponent_reconnected', {
                                playerId: game.disconnectedPlayerId
                            });
                            continue;
                        }
                    }

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
            const now = Date.now();
            const result = await Game.updateOne(
                { _id: game._id, status: 'ongoing' },
                {
                    $set: {
                        status: 'completed',
                        result: 'aborted',
                        resultReason: 'cancelled_due_to_first_move_timeout',
                        updatedAt: now,
                        queuedPremoves: { white: null, black: null }
                    }
                }
            );

            if (result.modifiedCount === 0) return;

            console.log(`⏱️  First move timeout for game ${game._id}`);

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
            const now = Date.now();
            const result = await Game.updateOne(
                { _id: game._id, status: 'ongoing' },
                {
                    $set: {
                        status: 'completed',
                        result: winner,
                        resultReason: 'timeout',
                        updatedAt: now,
                        queuedPremoves: { white: null, black: null }
                    }
                }
            );

            if (result.modifiedCount === 0) return;

            console.log(`⏱️  Timeout in game ${game._id}, winner: ${winner}`);
            await applyGameStats(game._id);

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
            const now = Date.now();

            // ATOMIC UPDATE: Only update if the game is still ongoing 
            // AND the disconnectedPlayerId hasn't been cleared by a concurrent reconnect.
            const result = await Game.updateOne(
                {
                    _id: game._id,
                    status: 'ongoing',
                    disconnectedPlayerId: game.disconnectedPlayerId
                },
                {
                    $set: {
                        status: 'completed',
                        result: winner,
                        resultReason: 'disconnect_timeout',
                        disconnectedPlayerId: null,
                        disconnectDeadlineAt: null,
                        updatedAt: now,
                        queuedPremoves: { white: null, black: null }, // Clean up premoves too
                    }
                }
            );

            // Guard: If modifiedCount is 0, another process (like a reconnect) beat us to it.
            if (result.modifiedCount === 0) {
                console.log(`⏱️  Disconnect timeout skipped for game ${game._id} (already handled or reconnected)`);
                return;
            }

            console.log(`⏱️  Disconnect timeout applied in game ${game._id}, winner: ${winner}`);

            await applyGameStats(game._id);

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
