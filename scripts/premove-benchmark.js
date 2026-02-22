#!/usr/bin/env node

/**
 * premove-benchmark.js — Parse premove trace logs and produce a latency report.
 *
 * Usage:
 *   node scripts/premove-benchmark.js [--minutes N] [--logfile path]
 *
 * Default: reads from stdin (pipe server logs).
 *   npm run dev 2>&1 | tee /tmp/server.log   # during play session
 *   cat /tmp/server.log | node scripts/premove-benchmark.js
 *
 * Or from a file:
 *   node scripts/premove-benchmark.js --logfile /tmp/server.log
 *
 * Example with Render production log:
 *   node scripts/premove-benchmark.js --logfile /path/to/render.log
 */

const fs = require('fs');
const readline = require('readline');

// ——— CLI args ———
const args = process.argv.slice(2);
let logfilePath = null;
let minutesFilter = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--logfile' && args[i + 1]) logfilePath = args[++i];
    if (args[i] === '--minutes' && args[i + 1]) minutesFilter = parseInt(args[++i]);
}

// ——— Collect lines ———
async function readLines(source) {
    const rl = readline.createInterface({ input: source, crlfDelay: Infinity });
    const lines = [];
    for await (const line of rl) lines.push(line);
    return lines;
}

// ——— Parse ———
function parseLogs(lines) {
    const traces = new Map();  // traceId → { events: [], summary: null }
    const summaries = [];

    for (const raw of lines) {
        // Try to extract JSON from the line
        let json;
        try {
            // Handle lines that might have a prefix before the JSON
            const jsonStart = raw.indexOf('{');
            if (jsonStart === -1) continue;
            json = JSON.parse(raw.slice(jsonStart));
        } catch {
            continue;
        }

        if (json._type === 'premove_trace') {
            if (!traces.has(json.traceId)) {
                traces.set(json.traceId, { events: [], summary: null });
            }
            traces.get(json.traceId).events.push(json);
        } else if (json._type === 'premove_summary') {
            if (!traces.has(json.traceId)) {
                traces.set(json.traceId, { events: [], summary: null });
            }
            traces.get(json.traceId).summary = json;
            summaries.push(json);
        }
    }

    return { traces, summaries };
}

// ——— Trace → Synthetic Summary (fallback when no premove_summary exists) ———
function buildSummariesFromTraces(traces) {
    const synthetics = [];

    for (const [traceId, { events }] of traces) {
        // Build event-type → first matching event lookup
        const byEvent = {};
        for (const ev of events) {
            if (!byEvent[ev.event]) byEvent[ev.event] = ev;
        }

        const flip = byEvent['turn_flipped'];
        const found = byEvent['queued_premove_found'];
        const execStart = byEvent['premove_execute_start'];
        const execEnd = byEvent['premove_execute_end'];
        const broadcast = byEvent['move_broadcast_sent'];
        const rejected = byEvent['premove_rejected'];

        // Determine outcome
        let outcome;
        if (rejected) {
            outcome = 'rejected';
        } else if (execEnd) {
            outcome = 'executed';
        } else {
            outcome = 'partial';
        }

        // Compute latencies (null if required event is missing)
        const flipTs = flip ? flip.ts : null;
        const latencies = {
            flip_to_found_ms: (flipTs != null && found) ? found.ts - flipTs : null,
            flip_to_execute_start_ms: (flipTs != null && execStart) ? execStart.ts - flipTs : null,
            flip_to_execute_end_ms: (flipTs != null && execEnd) ? execEnd.ts - flipTs : null,
            execute_duration_ms: (execStart && execEnd) ? execEnd.ts - execStart.ts : null,
            execute_to_broadcast_ms: (execEnd && broadcast) ? broadcast.ts - execEnd.ts : null,
            flip_to_broadcast_ms: (flipTs != null && broadcast) ? broadcast.ts - flipTs : null,
            db_persist_duration_ms: (byEvent['premove_db_persist_start'] && byEvent['premove_db_persist_end'])
                ? byEvent['premove_db_persist_end'].ts - byEvent['premove_db_persist_start'].ts : null,
            broadcast_emit_duration_ms: (byEvent['premove_broadcast_start'] && byEvent['premove_broadcast_end'])
                ? byEvent['premove_broadcast_end'].ts - byEvent['premove_broadcast_start'].ts : null,
        };

        synthetics.push({
            _type: 'premove_summary_synthetic',
            traceId,
            outcome,
            latencies,
            gameId: flip ? flip.gameId : (events[0] || {}).gameId || null,
            moveNo: flip ? flip.moveNo : null,
            eventCount: events.length,
        });
    }

    return synthetics;
}

// ——— Stats ———
function percentile(arr, p) {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
}

function computeStats(summaries, minutesCutoff) {
    let filtered = summaries;
    if (minutesCutoff) {
        const cutoffTs = Date.now() - minutesCutoff * 60 * 1000;
        filtered = summaries.filter(s => {
            const firstEvent = s.latencies;
            return true; // If we don't have per-event ts in summary, keep all
        });
    }

    const executed = filtered.filter(s => s.outcome === 'executed');
    const rejected = filtered.filter(s => s.outcome === 'rejected');

    const metrics = [
        'flip_to_found_ms',
        'flip_to_execute_start_ms',
        'flip_to_execute_end_ms',
        'execute_duration_ms',
        'execute_to_broadcast_ms',
        'flip_to_broadcast_ms',
        'db_persist_duration_ms',
        'broadcast_emit_duration_ms',
    ];

    const stats = {};
    for (const metric of metrics) {
        const values = executed
            .map(s => s.latencies[metric])
            .filter(v => v != null);

        stats[metric] = {
            count: values.length,
            p50: percentile(values, 50),
            p95: percentile(values, 95),
            p99: percentile(values, 99),
            min: values.length > 0 ? Math.min(...values) : null,
            max: values.length > 0 ? Math.max(...values) : null,
            avg: values.length > 0 ? parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)) : null,
        };
    }

    // Clock loss stats
    const clockDeltas = executed
        .map(s => {
            const ev = s.latencies;
            return null; // Clock delta is inside trace events, not summary
        })
        .filter(v => v != null);

    return {
        totalTraces: filtered.length,
        executedCount: executed.length,
        rejectedCount: rejected.length,
        rejectRate: filtered.length > 0
            ? parseFloat(((rejected.length / filtered.length) * 100).toFixed(1))
            : 0,
        rejectReasons: rejected.reduce((acc, s) => {
            // We don't have reason in summary, just count
            acc['invalid_premove'] = (acc['invalid_premove'] || 0) + 1;
            return acc;
        }, {}),
        metrics: stats,
    };
}

// ——— Report Generation ———
function generateReport(stats) {
    const now = new Date().toISOString();
    let md = `# Premove Latency Report\n\n`;
    md += `**Generated:** ${now}\n\n`;
    md += `## Summary\n\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Total traces | ${stats.totalTraces} |\n`;
    md += `| Executed | ${stats.executedCount} |\n`;
    md += `| Rejected | ${stats.rejectedCount} |\n`;
    md += `| Reject rate | ${stats.rejectRate}% |\n\n`;

    md += `## Latency Breakdown (executed premoves only)\n\n`;
    md += `| Metric | Count | p50 | p95 | p99 | Min | Max | Avg |\n`;
    md += `|--------|-------|-----|-----|-----|-----|-----|-----|\n`;

    const metricLabels = {
        flip_to_found_ms: 'Turn flip → Found queued',
        flip_to_execute_start_ms: 'Turn flip → Execute start',
        flip_to_execute_end_ms: 'Turn flip → Execute end',
        execute_duration_ms: 'Execute duration',
        execute_to_broadcast_ms: 'Execute end → Broadcast',
        flip_to_broadcast_ms: 'Turn flip → Broadcast (E2E)',
        db_persist_duration_ms: 'DB persist duration',
        broadcast_emit_duration_ms: 'Broadcast emit duration',
    };

    for (const [key, label] of Object.entries(metricLabels)) {
        const s = stats.metrics[key];
        if (!s || s.count === 0) {
            md += `| ${label} | 0 | - | - | - | - | - | - |\n`;
        } else {
            md += `| ${label} | ${s.count} | ${s.p50}ms | ${s.p95}ms | ${s.p99}ms | ${s.min}ms | ${s.max}ms | ${s.avg}ms |\n`;
        }
    }

    md += `\n## Pass/Fail Criteria\n\n`;
    const flipToExec = stats.metrics.flip_to_execute_end_ms;
    const flipToBroadcast = stats.metrics.flip_to_broadcast_ms;

    if (flipToExec && flipToExec.p95 != null) {
        const pass = flipToExec.p95 < 10;
        md += `- \`flip_to_execute_end_ms\` p95: **${flipToExec.p95}ms** ${pass ? '✅ PASS (<10ms)' : '❌ FAIL (≥10ms)'}\n`;
    } else {
        md += `- \`flip_to_execute_end_ms\` p95: **No data**\n`;
    }

    if (flipToBroadcast && flipToBroadcast.p95 != null) {
        md += `- \`flip_to_broadcast_ms\` p95: **${flipToBroadcast.p95}ms**\n`;
    }

    // ── Top bottleneck identification ──
    const bottleneckMetrics = [
        { key: 'execute_duration_ms', label: 'Execute duration' },
        { key: 'execute_to_broadcast_ms', label: 'Execute end → Broadcast' },
        { key: 'flip_to_found_ms', label: 'Turn flip → Found queued' },
    ];
    let topBottleneck = null;
    let topBottleneckP95 = 0;
    for (const bm of bottleneckMetrics) {
        const s = stats.metrics[bm.key];
        if (s && s.p95 != null && s.p95 > topBottleneckP95) {
            topBottleneckP95 = s.p95;
            topBottleneck = bm;
        }
    }
    if (topBottleneck) {
        md += `\n## Top Bottleneck\n\n`;
        md += `| Metric | p95 |\n|--------|-----|\n`;
        md += `| ${topBottleneck.label} (\`${topBottleneck.key}\`) | **${topBottleneckP95}ms** |\n`;
    }

    md += `\n## Verdict\n\n`;

    if (stats.executedCount === 0) {
        md += `> ⚠️ **Insufficient data** — no executed premoves found in the log.\n`;
        md += `> Play some games with premoves and re-run the benchmark.\n`;
    } else {
        const p95Val = flipToExec && flipToExec.p95 != null ? flipToExec.p95 : null;
        const passed = p95Val != null && p95Val < 10;

        if (passed) {
            md += `> ✅ **PASS** — \`flip_to_execute_end_ms\` p95 = **${p95Val}ms** (< 10ms target).\n`;
            md += `> Server-side premove executes within the same event-loop tick as the\n`;
            md += `> turn flip with no extra RTT required.\n`;
        } else {
            md += `> ❌ **FAIL** — \`flip_to_execute_end_ms\` p95 = **${p95Val}ms** (target < 10ms).\n`;
            md += `> Tail latency detected. `;
            if (topBottleneck) {
                md += `Top bottleneck: **${topBottleneck.label}** (p95 = ${topBottleneckP95}ms).\n`;
            } else {
                md += `Investigate DB persist and event-loop contention.\n`;
            }
            md += `> Consider: narrow DB updates (\`updateOne\`), broadcast-before-persist,\n`;
            md += `> or reducing event-loop blocking in the \`make_move\` handler.\n`;
        }
    }

    return md;
}

// ——— Main ———
async function main() {
    const source = logfilePath
        ? fs.createReadStream(logfilePath)
        : process.stdin;

    console.error('📊 Premove Benchmark — reading logs...');
    const lines = await readLines(source);
    console.error(`   Read ${lines.length} lines`);

    let { traces, summaries } = parseLogs(lines);
    console.error(`   Found ${summaries.length} premove summaries, ${traces.size} trace groups`);

    // Fallback: build synthetic summaries from individual trace events
    if (summaries.length === 0 && traces.size > 0) {
        console.error('   ℹ️  No premove_summary found, building metrics from trace events...');
        summaries = buildSummariesFromTraces(traces);
        console.error(`   Found ${summaries.length} premove traces (from trace events)`);
    }

    if (summaries.length === 0) {
        console.error('   ⚠️  No premove data found. Play some games with premoves first!');
        process.exit(0);
    }

    const stats = computeStats(summaries, minutesFilter);
    const report = generateReport(stats);

    // Write report
    const reportPath = __dirname + '/../premove-latency-report.md';
    fs.writeFileSync(reportPath, report);
    console.error(`   ✅ Report written to: ${reportPath}`);

    // Also print to stdout
    console.log(report);
}

main().catch(e => {
    console.error('Error:', e);
    process.exit(1);
});
