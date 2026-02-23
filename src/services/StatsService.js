/**
 * StatsService — Idempotent user stats counter updates on game completion.
 *
 * Design:
 *   1. Uses atomic `findOneAndUpdate` with `{ statsApplied: false }` guard
 *      to guarantee a game's stats are applied exactly once.
 *   2. Uses `User.updateOne({ clerkId }, { $inc })` for counter increments.
 *   3. Skips aborted games.
 *   4. Fail-safe: logs errors but never throws — game flow is not interrupted.
 */

const Game = require('../models/Game');
const User = require('../models/User');

/**
 * Apply game result to user stats (wins/losses/draws).
 * Idempotent: uses atomic statsApplied flag to prevent double-counting.
 *
 * @param {string} gameId - MongoDB _id of the completed game
 * @returns {Promise<boolean>} true if stats were applied, false if skipped
 */
async function applyGameStats(gameId) {
    try {
        // Atomic guard: set statsApplied=true only if currently false
        const game = await Game.findOneAndUpdate(
            { _id: gameId, statsApplied: { $ne: true } },
            { $set: { statsApplied: true } },
            { new: true }
        );

        // Already applied or game not found
        if (!game) {
            return false;
        }

        const { result, whitePlayer, blackPlayer } = game;

        // Skip aborted games
        if (result === 'aborted' || result == null) {
            return false;
        }

        if (result === 'white') {
            // White wins, black loses
            await Promise.all([
                User.updateOne({ clerkId: whitePlayer }, { $inc: { wins: 1 } }),
                User.updateOne({ clerkId: blackPlayer }, { $inc: { losses: 1 } }),
            ]);
        } else if (result === 'black') {
            // Black wins, white loses
            await Promise.all([
                User.updateOne({ clerkId: blackPlayer }, { $inc: { wins: 1 } }),
                User.updateOne({ clerkId: whitePlayer }, { $inc: { losses: 1 } }),
            ]);
        } else if (result === 'draw') {
            // Both draw
            await Promise.all([
                User.updateOne({ clerkId: whitePlayer }, { $inc: { draws: 1 } }),
                User.updateOne({ clerkId: blackPlayer }, { $inc: { draws: 1 } }),
            ]);
        }

        console.log(`📊 [Stats] Applied stats for game ${gameId}: result=${result}`);
        return true;
    } catch (error) {
        // Fail-safe: log but don't throw — game flow must not break
        console.error(`❌ [Stats] Failed to apply stats for game ${gameId}:`, error.message);
        return false;
    }
}

module.exports = { applyGameStats };
