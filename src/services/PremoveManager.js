const logger = require('../utils/logger');
const redis = require('./redisClient');

class PremoveManager {
    constructor() {
        this.LOCK_PREFIX = `${redis.appPrefix}lock:game:`;
    }

    /**
     * Set a premove for a player color (intent log only — actual persistence is in Handler).
     */
    setPremove(gameId, color, premove) {
        logger.debug(`📋 [PremoveManager] premove_set_intent`, { gameId, player: color });
    }

    /**
     * Get the *first* queued premove (queue index 0) for a player color.
     */
    getPremove(game, color) {
        if (!game || !game.queuedPremoves) return null;
        const queue = game.queuedPremoves[color];
        if (!Array.isArray(queue) || queue.length === 0) return null;
        const p = queue[0];
        if (!p || !p.from || !p.to) return null;
        return {
            from: p.from,
            to: p.to,
            promotion: p.promotion,
            setAt: p.setAt,
            sourceMoveNo: p.sourceMoveNo,
            traceId: p.traceId
        };
    }

    /**
     * Get the full queue array (up to 2 items) for a player color.
     */
    getQueue(game, color) {
        if (!game || !game.queuedPremoves) return [];
        const queue = game.queuedPremoves[color];
        return Array.isArray(queue) ? queue : [];
    }

    hasPremove(game, color) {
        return this.getPremove(game, color) !== null;
    }

    /**
     * Returns true if the queue is full (max 2 items).
     */
    isQueueFull(game, color) {
        return this.getQueue(game, color).length >= 2;
    }

    clearPremove(gameId, color, reason = 'unknown') {
        logger.debug(`🧹 [PremoveManager] premove_shifted_intent`, { gameId, player: color, reason });
    }

    clearAll(gameId, reason = 'unknown') {
        logger.debug(`🧹 [PremoveManager] game_cleaned_intent`, { gameId, reason });
    }

    rehydrate(gameId, queuedPremoves) {
        // No-op in stateless mode, as we fetch from DB every time in Handler
    }

    /**
     * Execute fn inside a REDIS distributed lock.
     */
    async withLock(gameId, fn) {
        const lockKey = `${this.LOCK_PREFIX}${gameId}`;
        const lockValue = Date.now() + 5000; // 5s timeout

        let acquired = false;
        const retryLimit = 30;
        const retryDelay = 100;

        for (let i = 0; i < retryLimit; i++) {
            // SET key value NX PX 5000 — Atomic lock acquire
            const result = await redis.set(lockKey, 'locked', 'NX', 'PX', 5000);
            if (result === 'OK') {
                acquired = true;
                break;
            }
            await new Promise(r => setTimeout(r, retryDelay));
        }

        if (!acquired) {
            throw new Error('Could not acquire game lock. System busy.');
        }

        try {
            return await fn();
        } finally {
            // Simple unlock (ignoring race condition on expiration for simplicity in this pass)
            await redis.del(lockKey);
        }
    }
}

const premoveManager = new PremoveManager();
module.exports = premoveManager;
