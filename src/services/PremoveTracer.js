/**
 * PremoveTracer — Structured logging & high-res timing for premove pipeline.
 *
 * Controlled by TRACE_PREMOVE env flag via logger.tracePremove.
 * When disabled (default), start() returns a no-op trace — zero overhead.
 * When enabled  (TRACE_PREMOVE=1), emits single-line JSON logs with sub-ms precision.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

// ——— No-op trace object (returned when tracing is disabled) ———
const NOOP_TRACE = Object.freeze({
    mark() { },
    summary() { return {}; },
});

class PremoveTracer {
    /**
     * Create a new trace context for a single premove attempt.
     * Returns a no-op when TRACE_PREMOVE is off.
     * @param {string} gameId
     * @param {string} color 'white' | 'black'
     * @param {number} moveNo  chess.history().length at trace start
     * @returns {PremoveTrace}
     */
    static start(gameId, color, moveNo) {
        if (!logger.tracePremove) return NOOP_TRACE;
        return new PremoveTrace(gameId, color, moveNo);
    }
}

class PremoveTrace {
    constructor(gameId, color, moveNo) {
        this.traceId = crypto.randomBytes(4).toString('hex'); // 8-char hex
        this.gameId = gameId;
        this.color = color;
        this.moveNo = moveNo;
        this._hrOrigin = process.hrtime.bigint();
        this._tsOrigin = Date.now();

        // Collected timestamps (wall-clock ms)
        this.timestamps = {};
    }

    /**
     * Record a named event with high-res timing.
     * @param {string} event  e.g. "turn_flipped", "premove_execute_start"
     * @param {object} [meta] optional metadata
     */
    mark(event, meta) {
        const wallMs = Date.now();
        const hrElapsed = Number(process.hrtime.bigint() - this._hrOrigin) / 1e6; // ns → ms

        this.timestamps[event] = wallMs;

        const entry = {
            _type: 'premove_trace',
            traceId: this.traceId,
            event,
            gameId: this.gameId,
            moveNo: this.moveNo,
            color: this.color,
            ts: wallMs,
            hr_elapsed_ms: parseFloat(hrElapsed.toFixed(3)),
        };

        if (meta && Object.keys(meta).length > 0) {
            entry.meta = meta;
        }

        console.log(JSON.stringify(entry));
    }

    /**
     * Emit a summary log with all derived latencies.
     * Call after the last mark().
     */
    summary() {
        const t = this.timestamps;
        const derive = (a, b) => (t[a] != null && t[b] != null) ? t[b] - t[a] : null;

        const latencies = {
            flip_to_found_ms: derive('turn_flipped', 'queued_premove_found'),
            flip_to_execute_start_ms: derive('turn_flipped', 'premove_execute_start'),
            flip_to_execute_end_ms: derive('turn_flipped', 'premove_execute_end'),
            execute_duration_ms: derive('premove_execute_start', 'premove_execute_end'),
            execute_to_broadcast_ms: derive('premove_execute_end', 'move_broadcast_sent'),
            flip_to_broadcast_ms: derive('turn_flipped', 'move_broadcast_sent'),
        };

        const entry = {
            _type: 'premove_summary',
            traceId: this.traceId,
            gameId: this.gameId,
            moveNo: this.moveNo,
            color: this.color,
            outcome: t.premove_rejected ? 'rejected' : 'executed',
            latencies,
        };

        console.log(JSON.stringify(entry));
        return latencies;
    }
}

module.exports = PremoveTracer;
