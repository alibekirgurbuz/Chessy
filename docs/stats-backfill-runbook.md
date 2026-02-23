# Stats Backfill Runbook

## 1. Purpose

Recalculate `User.wins / losses / draws` counters from the `Game` collection. Fixes stale or zero-valued counters caused by games completed before TASK-04 (stats hook implementation).

## 2. When to Run

- **Post-deploy (one-time):** After deploying the TASK-04 `statsApplied` hook for the first time.
- **Data repair:** If counters are suspected to be out of sync (e.g. after a DB restore or manual game edits).
- **Never in routine operation.** The `StatsService.applyGameStats()` hook handles all new games automatically.

## 3. Preconditions

| Condition | Check |
|-----------|-------|
| MongoDB accessible | `.env` has valid `MONGODB_URI` |
| No active deploy | Backfill resets counters — running mid-deploy could cause brief stat inconsistency |
| Node.js available | `node >= 18` |
| Working directory | `apps/backend/` |

## 4. Command

```bash
cd apps/backend
node scripts/backfill-stats.js
```

## 5. Safety Checks Before Run

1. **Confirm no active games** — counters reset to 0 temporarily; if a game finishes during backfill, its stats may be double-counted (the hook fires AND the backfill counts it). Mitigated by the `statsApplied` flag but safest to run during low-traffic.
2. **Backup User collection** (optional but recommended):
   ```bash
   mongodump --uri="$MONGODB_URI" --collection=users --out=./backup-$(date +%Y%m%d)
   ```

## 6. Validation After Run

| What | How |
|------|-----|
| Script output | Check `Applied stats for N games` line — N should match completed non-aborted game count |
| User stats table | Script prints per-user W/L/D summary at the end |
| API check | `GET /api/profile/overview` with auth → `stats.totalGames` should be > 0 for active users |
| DB spot check | `db.users.find({}, {username:1, wins:1, losses:1, draws:1})` |

## 7. Re-run Policy

**Safe to re-run.** The script:
1. Resets ALL user counters to `{wins: 0, losses: 0, draws: 0}`
2. Recomputes from every completed, non-aborted game
3. Sets `statsApplied: true` on all processed games

Result is always deterministic. No double-counting risk from re-runs.

## 8. Rollback / Recovery

| Scenario | Action |
|----------|--------|
| Counters wrong after backfill | Re-run the script — it's idempotent |
| Need to undo entirely | Restore from `mongodump` backup |
| Script crashes mid-run | Some users may have partial counts; re-run to fix |

## 9. Known Caveats

- **Aborted games** (`result: 'aborted'`) are **excluded** — no counter impact.
- **Guest players** (`clerkId` not in User collection) — `updateOne` silently matches 0 documents. No error, no counter.
- **Counter source:** Counters come from User model fields, NOT from Game aggregation. If a game exists but its players' User records were deleted, the game still shows in `recentGames` but has no counter effect.
- **Temporary zero stats:** During backfill execution, all users briefly have `wins=losses=draws=0`. If a user queries `/api/profile/overview` at that exact moment, they see zero stats. Window is typically < 2 seconds.

## 10. Example Expected Output

```
✅ Connected to MongoDB
🔄 Reset 2 users' stats to 0
📊 Found 30 completed games to process
✅ Applied stats for 30 games

📋 Updated User Stats:
────────────────────────────────────────────────────────────
  bekirov: W0 / L1 / D0 (total: 1)
  alibov: W1 / L0 / D0 (total: 1)

✅ Done. Database connection closed.
```
