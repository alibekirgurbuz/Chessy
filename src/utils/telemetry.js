/**
 * Lightweight telemetry utility for measuring end-to-end socket events on the backend.
 * Enabled via SOCKET_DEBUG_METRICS=true in the environment.
 */
const crypto = require('crypto');

const isEnabled = process.env.SOCKET_DEBUG_METRICS === 'true';

const Telemetry = {
    /**
     * Logs a structured JSON event to the console if telemetry is enabled.
     */
    log(payload) {
        if (!isEnabled) return;

        try {
            const logEntry = {
                ts: Date.now(),
                ...payload
            };

            // Format structured JSON without object truncation
            console.log(`[TELEMETRY] ${JSON.stringify(logEntry)}`);
        } catch (e) {
            // Failsafe
            console.warn('[TELEMETRY_ERROR] Failed to serialize payload', e);
        }
    },

    /**
     * Trace ID generation
     */
    generateTraceId() {
        return crypto.randomUUID();
    }
};

module.exports = Telemetry;
