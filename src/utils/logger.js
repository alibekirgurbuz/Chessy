/**
 * WS-05: Lightweight logger with environment-flag support.
 *
 * Environment variables:
 *   LOG_LEVEL      — error | warn | info | debug  (default: "info")
 *   TRACE_PREMOVE  — "1" to enable premove trace output (default: "0")
 *
 * Production recommended: LOG_LEVEL=warn  TRACE_PREMOVE=0
 * Benchmark mode:         LOG_LEVEL=debug TRACE_PREMOVE=1
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
const tracePremove = process.env.TRACE_PREMOVE === '1';
const instanceId = process.env.INSTANCE_ID || process.env.RENDER_INSTANCE_ID || `pid-${process.pid}`;

const format = (args) => {
    return [`[${instanceId}]`, ...args];
};

const logger = {
    error: (...args) => console.error(...format(args)),

    warn: (...args) => {
        if (currentLevel >= LEVELS.warn) console.warn(...format(args));
    },

    info: (...args) => {
        if (currentLevel >= LEVELS.info) console.log(...format(args));
    },

    debug: (...args) => {
        if (currentLevel >= LEVELS.debug) console.log(...format(args));
    },

    /** Whether premove tracing is active (TRACE_PREMOVE=1) */
    tracePremove,
    instanceId
};

module.exports = logger;
