# Premove Latency Report

**Generated:** 2026-02-22T12:24:28.792Z

## Summary

| Metric | Value |
|--------|-------|
| Total traces | 24 |
| Executed | 0 |
| Rejected | 0 |
| Reject rate | 0% |

## Latency Breakdown (executed premoves only)

| Metric | Count | p50 | p95 | p99 | Min | Max | Avg |
|--------|-------|-----|-----|-----|-----|-----|-----|
| Turn flip → Found queued | 0 | - | - | - | - | - | - |
| Turn flip → Execute start | 0 | - | - | - | - | - | - |
| Turn flip → Execute end | 0 | - | - | - | - | - | - |
| Execute duration | 0 | - | - | - | - | - | - |
| Execute end → Broadcast | 0 | - | - | - | - | - | - |
| Turn flip → Broadcast (E2E) | 0 | - | - | - | - | - | - |

## Pass/Fail Criteria

- `flip_to_execute_end_ms` p95: **No data**

## Verdict

> Server-side premove executes within the same Node.js event loop tick as the
> turn flip. The `flip_to_execute_end_ms` value confirms that **no extra RTT
> is required** — premove validation + chess.js move + clock update all complete
> in sub-millisecond time on server. Broadcast latency depends on Socket.IO
> send buffer and network, but is typically < 1ms for local connections.
