# Premove Latency Report

**Generated:** 2026-02-22T13:15:31.535Z

## Summary

| Metric | Value |
|--------|-------|
| Total traces | 10 |
| Executed | 10 |
| Rejected | 0 |
| Reject rate | 0% |

## Latency Breakdown (executed premoves only)

| Metric | Count | p50 | p95 | p99 | Min | Max | Avg |
|--------|-------|-----|-----|-----|-----|-----|-----|
| Turn flip → Found queued | 10 | 0ms | 1ms | 1ms | 0ms | 1ms | 0.2ms |
| Turn flip → Execute start | 10 | 0ms | 1ms | 1ms | 0ms | 1ms | 0.2ms |
| Turn flip → Execute end | 10 | 1ms | 2ms | 2ms | 0ms | 2ms | 1.1ms |
| Execute duration | 10 | 1ms | 1ms | 1ms | 0ms | 1ms | 0.9ms |
| Execute end → Broadcast | 10 | 3ms | 5ms | 5ms | 1ms | 5ms | 3ms |
| Turn flip → Broadcast (E2E) | 10 | 3ms | 6ms | 6ms | 3ms | 6ms | 4.1ms |
| DB persist duration | 10 | 89ms | 95ms | 95ms | 88ms | 95ms | 90.1ms |
| Broadcast emit duration | 10 | 1ms | 3ms | 3ms | 0ms | 3ms | 1.4ms |

## Pass/Fail Criteria

- `flip_to_execute_end_ms` p95: **2ms** ✅ PASS (<10ms)
- `flip_to_broadcast_ms` p95: **6ms**

## Top Bottleneck

| Metric | p95 |
|--------|-----|
| Execute end → Broadcast (`execute_to_broadcast_ms`) | **5ms** |

## Verdict

> ✅ **PASS** — `flip_to_execute_end_ms` p95 = **2ms** (< 10ms target).
> Server-side premove executes within the same event-loop tick as the
> turn flip with no extra RTT required.
