# Premove Latency Measurement — Runbook

## Prerequisites
- Backend running: `cd apps/backend && npm run dev`
- Web dev server: `cd apps/web && npm run dev`
- 2 browser tabs (or 1 browser + 1 mobile) logged in as different users

## Step 1: Start server with log capture
```bash
cd apps/backend
npm run dev 2>&1 | tee /tmp/premove-server.log
```

## Step 2: Play a game with premoves
1. Open two browser tabs, both navigate to the app
2. Start a game (matchmaking or direct link)
3. On **Black's** side: make a premove (click piece, click destination while it's White's turn)
4. On **White's** side: play a normal move (e.g. e4)
5. Observe the premove auto-execute on the server
6. Repeat ~10 times alternating premoves between both sides

### Tips
- Use bullet (1+0) or blitz (3+0) for quick testing
- Try both valid and invalid premoves to test reject paths
- Try cancelling premoves before they execute

## Step 3: Generate the report
```bash
# From the captured log file
cat /tmp/premove-server.log | node scripts/premove-benchmark.js

# Or with a time filter (last 5 minutes only)
cat /tmp/premove-server.log | node scripts/premove-benchmark.js --minutes 5
```

The report is written to: `apps/backend/premove-latency-report.md`

## Step 4: Interpret the results

### Key metrics
| Metric | Target | Meaning |
|--------|--------|---------|
| `flip_to_execute_end_ms` p95 | **< 10ms** | Total time from turn flip to premove execution complete |
| `execute_duration_ms` p95 | **< 5ms** | Chess.js validate + execute + clock update |
| `flip_to_broadcast_ms` p95 | **< 15ms** | Full pipeline including Socket.IO emit |
| Reject rate | **< 20%** | % of premoves that were invalid at execution time |

### Expected results
- `flip_to_execute_end_ms`: **0-2ms** (same event loop tick)
- `execute_duration_ms`: **< 1ms** (chess.js is fast)
- `flip_to_broadcast_ms`: **0-3ms** (Socket.IO emit is synchronous)
- Clock delta: **< 100ms** (mostly increment-based, minimal time loss)

### Verdict criteria
✅ **PASS** if `flip_to_execute_end_ms` p95 < 10ms — confirms no extra RTT  
❌ **FAIL** if p95 ≥ 10ms — investigate DB save latency or lock contention

## Log Event Schema

Each premove attempt produces these JSON log lines:

```json
{"_type":"premove_trace","traceId":"a1b2c3d4","event":"turn_flipped",     "gameId":"...","moveNo":5,"color":"black","ts":1740170000000,"hr_elapsed_ms":0}
{"_type":"premove_trace","traceId":"a1b2c3d4","event":"queued_premove_found","gameId":"...","moveNo":5,"color":"black","ts":1740170000000,"hr_elapsed_ms":0.1,"meta":{"from":"d7","to":"d5"}}
{"_type":"premove_trace","traceId":"a1b2c3d4","event":"premove_execute_start","gameId":"...","moveNo":5,"color":"black","ts":1740170000000,"hr_elapsed_ms":0.2}
{"_type":"premove_trace","traceId":"a1b2c3d4","event":"premove_execute_end","gameId":"...","moveNo":5,"color":"black","ts":1740170000001,"hr_elapsed_ms":0.8,"meta":{"move":"d5","clock_before_ms":180000,"clock_after_ms":180000,"clock_delta_ms":0}}
{"_type":"premove_trace","traceId":"a1b2c3d4","event":"move_broadcast_sent","gameId":"...","moveNo":5,"color":"black","ts":1740170000001,"hr_elapsed_ms":0.9}
{"_type":"premove_trace","traceId":"a1b2c3d4","event":"clock_update_sent","gameId":"...","moveNo":5,"color":"black","ts":1740170000001,"hr_elapsed_ms":1.0}
{"_type":"premove_summary","traceId":"a1b2c3d4","gameId":"...","moveNo":5,"color":"black","outcome":"executed","latencies":{"flip_to_found_ms":0,"flip_to_execute_start_ms":0,"flip_to_execute_end_ms":1,"execute_duration_ms":1,"execute_to_broadcast_ms":0,"flip_to_broadcast_ms":1}}
```
