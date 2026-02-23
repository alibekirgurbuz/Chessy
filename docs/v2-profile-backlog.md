# V2 Profile Integration Backlog

This document outlines the planned improvements for the Profile Page and its API integration in the next iteration (V2).

## 1. Recent Games Pagination
*   **Description**: Currently, the `/api/profile/overview` endpoint returns a hardcoded limit of 10 recent games. As history grows, users need to see older games.
*   **Acceptance Criteria**:
    *   Backend endpoint supports `limit` and `offset` (or cursor-based) query parameters.
    *   Frontend UI includes a "Daha fazla göster" (Load More) button or infinite scroll at the bottom of the *Son Oyunlar* list.
    *   Clicking the button fetches the next batch and appends it to the `recentGames` state.

## 2. Advanced Retry & Backoff Strategy
*   **Description**: The current error state provides a simple manual "Tekrar Dene" button. A more robust system should handle transient network errors automatically.
*   **Acceptance Criteria**:
    *   Implement automatic retries (e.g., using a library like `react-query` or custom exponential backoff logic) before showing the error state.
    *   Add user-friendly toast notifications for background sync failures.
    *   Ensure the manual retry button remains as a fallback.

## 3. Error Telemetry & Monitoring
*   **Description**: We lack visibility into how often the profile API fails for users in production.
*   **Acceptance Criteria**:
    *   Implement an error tracking hook (e.g., Sentry or a custom logging endpoint).
    *   Log instances where `/api/profile/overview` returns 500s or timeouts.
    *   Log incidents of "corrupt game records" (where a game fails to render and hits the fallback guard).

## 4. (Optional) Stale-While-Revalidate / Caching
*   **Description**: To make the profile page feel instantaneous, we can cache the last known stats and games.
*   **Acceptance Criteria**:
    *   Use `SWR` or `React Query` to cache the profile overview data.
    *   Show cached data immediately on load while fetching fresh data in the background (stale-while-revalidate).
    *   Remove the full-screen loading spinner for subsequent visits.
