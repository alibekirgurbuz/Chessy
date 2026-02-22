/**
 * PremoveManager - Server-side premove queue with per-game locking
 * 
 * Stores queued premoves in-memory per game, keyed by color.
 * Provides a withLock(gameId, fn) wrapper to serialize mutations
 * on the same game, preventing double-execute and race conditions.
 */
const logger = require('../utils/logger');

class PremoveManager {
    constructor() {
        // Map<gameId, { white: Premove|null, black: Premove|null }>
        this._store = new Map();
        // Map<gameId, Promise> — serialization lock per game
        this._locks = new Map();
    }

    /**
     * Ensure a store entry exists for the given gameId.
     */
    _ensure(gameId) {
        if (!this._store.has(gameId)) {
            this._store.set(gameId, { white: null, black: null });
        }
        return this._store.get(gameId);
    }

    /**
     * Set a premove for a player color. Overwrites any existing premove.
     * @param {string} gameId
     * @param {'white'|'black'} color
     * @param {{ from: string, to: string, promotion?: string }} premove
     */
    setPremove(gameId, color, premove) {
        const entry = this._ensure(gameId);
        entry[color] = { from: premove.from, to: premove.to, promotion: premove.promotion || undefined };

        logger.debug(`📋 [PremoveManager] premove_set`, {
            gameId, player: color,
            from: premove.from, to: premove.to,
            promotion: premove.promotion || null
        });
    }

    /**
     * Get the queued premove for a player color.
     * @param {string} gameId
     * @param {'white'|'black'} color
     * @returns {{ from: string, to: string, promotion?: string } | null}
     */
    getPremove(gameId, color) {
        const entry = this._store.get(gameId);
        if (!entry) return null;
        return entry[color] || null;
    }

    /**
     * Clear a specific player's premove.
     * @param {string} gameId
     * @param {'white'|'black'} color
     * @param {string} reason
     */
    clearPremove(gameId, color, reason = 'unknown') {
        const entry = this._store.get(gameId);
        if (!entry) return;
        const had = entry[color];
        entry[color] = null;

        if (had) {
            logger.debug(`🧹 [PremoveManager] premove_cleared`, {
                gameId, player: color, reason,
                from: had.from, to: had.to
            });
        }
    }

    /**
     * Clear all premoves for a game and remove the store entry.
     * @param {string} gameId
     * @param {string} reason
     */
    clearAll(gameId, reason = 'unknown') {
        const entry = this._store.get(gameId);
        if (entry) {
            if (entry.white) {
                logger.debug(`🧹 [PremoveManager] premove_cleared`, {
                    gameId, player: 'white', reason,
                    from: entry.white.from, to: entry.white.to
                });
            }
            if (entry.black) {
                logger.debug(`🧹 [PremoveManager] premove_cleared`, {
                    gameId, player: 'black', reason,
                    from: entry.black.from, to: entry.black.to
                });
            }
        }
        this._store.delete(gameId);
        this._locks.delete(gameId);
    }

    /**
     * Execute fn inside a per-game serial lock.
     * Ensures only one mutation on a gameId runs at a time.
     * @param {string} gameId
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async withLock(gameId, fn) {
        // Wait for any pending operation on this game
        const pending = this._locks.get(gameId) || Promise.resolve();

        let resolve;
        const next = new Promise(r => { resolve = r; });
        this._locks.set(gameId, next);

        try {
            await pending;
            return await fn();
        } finally {
            resolve();
        }
    }
}

// Singleton instance
const premoveManager = new PremoveManager();

module.exports = premoveManager;
