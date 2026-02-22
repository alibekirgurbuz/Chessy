# Premove Latency Report

**Generated:** 2026-02-22T13:00:41.240Z

## Summary

| Metric | Value |
|--------|-------|
| Total traces | 14 |
| Executed | 14 |
| Rejected | 0 |
| Reject rate | 0% |

## Latency Breakdown (executed premoves only)

| Metric | Count | p50 | p95 | p99 | Min | Max | Avg |
|--------|-------|-----|-----|-----|-----|-----|-----|
| Turn flip → Found queued | 14 | 0ms | 1ms | 1ms | 0ms | 1ms | 0.286ms |
| Turn flip → Execute start | 14 | 0ms | 3ms | 3ms | 0ms | 3ms | 0.5ms |
| Turn flip → Execute end | 14 | 1ms | 96ms | 96ms | 0ms | 96ms | 8.143ms |
| Execute duration | 14 | 1ms | 96ms | 96ms | 0ms | 96ms | 7.643ms |
| Execute end → Broadcast | 14 | 96ms | 176ms | 176ms | 91ms | 176ms | 108.429ms |
| Turn flip → Broadcast (E2E) | 14 | 98ms | 196ms | 196ms | 91ms | 196ms | 116.571ms |
| DB persist duration | 0 | - | - | - | - | - | - |
| Broadcast emit duration | 0 | - | - | - | - | - | - |

## Pass/Fail Criteria

- `flip_to_execute_end_ms` p95: **96ms** ❌ FAIL (≥10ms)
- `flip_to_broadcast_ms` p95: **196ms**

## Top Bottleneck

| Metric | p95 |
|--------|-----|
| Execute end → Broadcast (`execute_to_broadcast_ms`) | **176ms** |

## Verdict

> ❌ **FAIL** — `flip_to_execute_end_ms` p95 = **96ms** (target < 10ms).
> Tail latency detected. Top bottleneck: **Execute end → Broadcast** (p95 = 176ms).
> Consider: narrow DB updates (`updateOne`), broadcast-before-persist,
> or reducing event-loop blocking in the `make_move` handler.
