# Premove Latency Report

**Generated:** 2026-02-26T22:36:52.369Z

## Summary

| Metric | Value |
|--------|-------|
| Total traces | 12 |
| Executed | 11 |
| Rejected | 1 |
| Reject rate | 8.3% |

## Latency Breakdown (executed premoves only)

| Metric | Count | p50 | p95 | p99 | Min | Max | Avg |
|--------|-------|-----|-----|-----|-----|-----|-----|
| Turn flip → Found queued | 11 | 0ms | 0ms | 0ms | 0ms | 0ms | 0ms |
| Turn flip → Execute start | 11 | 0ms | 0ms | 0ms | 0ms | 0ms | 0ms |
| Turn flip → Execute end | 11 | 1ms | 1ms | 1ms | 0ms | 1ms | 0.818ms |
| Execute duration | 11 | 1ms | 1ms | 1ms | 0ms | 1ms | 0.818ms |
| Execute end → Broadcast | 11 | 3ms | 5ms | 5ms | 1ms | 5ms | 3ms |
| Turn flip → Broadcast (E2E) | 11 | 4ms | 6ms | 6ms | 2ms | 6ms | 3.818ms |
| DB persist duration | 11 | 195ms | 237ms | 237ms | 173ms | 237ms | 200.364ms |
| Broadcast emit duration | 11 | 2ms | 7ms | 7ms | 1ms | 7ms | 3ms |

## Pass/Fail Criteria

- `flip_to_execute_end_ms` p95: **1ms** ✅ PASS (<10ms)
- `flip_to_broadcast_ms` p95: **6ms**

## Top Bottleneck

| Metric | p95 |
|--------|-----|
| Execute end → Broadcast (`execute_to_broadcast_ms`) | **5ms** |

## Verdict

> ✅ **PASS** — `flip_to_execute_end_ms` p95 = **1ms** (< 10ms target).
> Server-side premove executes within the same event-loop tick as the
> turn flip with no extra RTT required.
