const logger = require('../utils/logger');
const redis = require('./redisClient');

class PremoveManager {
    constructor() {
        this.LOCK_PREFIX = `${redis.appPrefix}lock:game:`;
    }

    /**
     * Set a premove for a player color.
     */
    setPremove(gameId, color, premove) {
        // We rely on the Game model storage for persistence, 
        // but we can also use Redis for a "hot" cache if needed.
        // For now, simplicity: just a placeholder as Handler updates DB.
        logger.debug(`📋 [PremoveManager] premove_set_intent`, { gameId, player: color });
    }

    /**
     * Get the queued premove from the game object (which is the source of truth).
     */
    getPremove(game, color) {
        if (!game || !game.queuedPremoves) return null;
        const p = game.queuedPremoves[color];
        if (!p || !p.from || !p.to) return null;
        return {
            from: p.from,
            to: p.to,
            promotion: p.promotion,
            setAt: p.setAt,
            sourceMoveNo: p.sourceMoveNo
        };
    }

    hasPremove(game, color) {
        return this.getPremove(game, color) !== null;
    }

    clearPremove(gameId, color, reason = 'unknown') {
        logger.debug(`🧹 [PremoveManager] premove_cleared_intent`, { gameId, player: color, reason });
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
