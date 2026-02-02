/**
 * ClockManager - Professional chess clock with lag compensation
 * Manages timing, increments, and timeout detection
 */

class ClockManager {
    constructor(timeControl) {
        this.baseTime = timeControl.time * 60 * 1000; // Convert minutes to milliseconds
        this.increment = timeControl.increment * 1000; // Convert seconds to milliseconds

        this.whiteTime = this.baseTime;
        this.blackTime = this.baseTime;
        this.activeColor = null; // 'w' or 'b', null = not started
        this.lastMoveAt = null;
        this.firstMoveDeadline = null;
        this.moveCount = 0;
    }

    /**
     * Start first move timer (30 seconds for white's first move)
     */
    startFirstMoveTimer(configuredSeconds = 30) {
        this.firstMoveDeadline = Date.now() + (configuredSeconds * 1000);
        return this.firstMoveDeadline;
    }

    /**
     * Start the clock on first move
     */
    startClock() {
        this.activeColor = 'w';
        this.lastMoveAt = Date.now();
        this.firstMoveDeadline = null;
    }

    /**
     * Process a move with lag compensation
     * @param {string} color - 'w' or 'b'
     * @param {number} clientTimestamp - When client sent the move
     * @returns {Object} Updated clock state
     */
    makeMove(color, clientTimestamp) {
        const serverTimestamp = Date.now();

        // First move special handling
        if (this.activeColor === null) {
            // Only white can make the first move
            if (color !== 'w') {
                throw new Error('White must make the first move');
            }
            this.startClock();
            this.moveCount++;
            // Switch to black's turn after white's first move
            this.activeColor = 'b';
            this.lastMoveAt = serverTimestamp;
            return this.getState();
        }

        // Validate it's the player's turn
        if (this.activeColor !== color) {
            throw new Error('Not your turn');
        }

        // Calculate elapsed time
        const elapsed = serverTimestamp - this.lastMoveAt;

        // Deduct elapsed time from active player
        if (this.activeColor === 'w') {
            this.whiteTime -= elapsed;
        } else {
            this.blackTime -= elapsed;
        }

        // Apply lag compensation
        const compensation = this._calculateLagCompensation(
            clientTimestamp,
            serverTimestamp
        );

        if (this.activeColor === 'w') {
            this.whiteTime += compensation;
        } else {
            this.blackTime += compensation;
        }

        // Add increment
        if (this.activeColor === 'w') {
            this.whiteTime += this.increment;
        } else {
            this.blackTime += this.increment;
        }

        // Check timeout
        if (this.whiteTime <= 0 || this.blackTime <= 0) {
            return {
                timeout: true,
                winner: this.whiteTime <= 0 ? 'black' : 'white',
                ...this.getState()
            };
        }

        // Switch turn
        this.activeColor = this.activeColor === 'w' ? 'b' : 'w';
        this.lastMoveAt = serverTimestamp;
        this.moveCount++;

        return this.getState();
    }

    /**
     * Calculate lag compensation (max 500ms)
     */
    _calculateLagCompensation(clientTimestamp, serverTimestamp) {
        const MAX_LAG_COMPENSATION = 500; // ms

        // Validate timestamps
        if (!clientTimestamp || clientTimestamp > serverTimestamp) {
            return 0; // Invalid timestamp, no compensation
        }

        const networkDelay = serverTimestamp - clientTimestamp;

        // Cap compensation at 500ms to prevent exploitation
        return Math.min(networkDelay, MAX_LAG_COMPENSATION);
    }

    /**
     * Check if first move deadline has expired
     */
    isFirstMoveExpired() {
        if (!this.firstMoveDeadline) return false;
        return Date.now() > this.firstMoveDeadline;
    }

    /**
     * Get current remaining time for active player
     */
    getCurrentTime() {
        if (!this.activeColor || !this.lastMoveAt) {
            return {
                whiteTime: this.whiteTime,
                blackTime: this.blackTime
            };
        }

        const now = Date.now();
        const elapsed = now - this.lastMoveAt;

        return {
            whiteTime: this.activeColor === 'w'
                ? Math.max(0, this.whiteTime - elapsed)
                : this.whiteTime,
            blackTime: this.activeColor === 'b'
                ? Math.max(0, this.blackTime - elapsed)
                : this.blackTime
        };
    }

    /**
     * Check if timeout has occurred
     */
    isTimeout() {
        const times = this.getCurrentTime();
        return times.whiteTime <= 0 || times.blackTime <= 0;
    }

    /**
     * Get full clock state
     */
    getState() {
        const times = this.getCurrentTime();
        return {
            whiteTime: Math.max(0, times.whiteTime),
            blackTime: Math.max(0, times.blackTime),
            activeColor: this.activeColor,
            lastMoveAt: this.lastMoveAt,
            firstMoveDeadline: this.firstMoveDeadline,
            moveCount: this.moveCount,
            baseTime: this.baseTime,
            increment: this.increment
        };
    }

    /**
     * Serialize clock state for database
     */
    toJSON() {
        return {
            whiteTime: this.whiteTime,
            blackTime: this.blackTime,
            activeColor: this.activeColor,
            lastMoveAt: this.lastMoveAt,
            firstMoveDeadline: this.firstMoveDeadline,
            moveCount: this.moveCount,
            baseTime: this.baseTime,
            increment: this.increment
        };
    }

    /**
     * Restore clock state from database
     */
    static fromJSON(data) {
        const clock = new ClockManager({
            time: data.baseTime / 60000,
            increment: data.increment / 1000
        });

        clock.whiteTime = data.whiteTime;
        clock.blackTime = data.blackTime;
        clock.activeColor = data.activeColor;
        clock.lastMoveAt = data.lastMoveAt;
        clock.firstMoveDeadline = data.firstMoveDeadline;
        clock.moveCount = data.moveCount || 0;

        return clock;
    }
}

module.exports = ClockManager;
