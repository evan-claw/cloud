# Cloud Sessions UI Redesign

## Goal

Improve the session browsing experience in the existing ChatSidebar. Keep the current 3-column layout (AppSidebar + ChatSidebar + Chat) and route structure intact. Focus on making sessions discoverable — groupable by project/branch, searchable, filterable, and organized by lifecycle state (open vs archived) — within the existing sidebar.

## Current State

- **ChatSidebar** (`src/components/cloud-agent-next/ChatSidebar.tsx`): flat list of 10 most recent sessions, no search, no filtering, no grouping. Each card shows title, repo, and time.
- **Sessions page** (`/cloud/sessions`): separate page with search, platform filter, and sub-session toggle — but uses a modal dialog to open sessions.
- Sessions have `git_url` and `git_branch` (V2 only) fields that are unused for grouping.
- **No session lifecycle state in DB**: no "running", "completed", "needs attention", or "archived" column exists on `cliSessions` or `cli_sessions_v2`. Status is either transient (WebSocket atoms: `idle`/`busy`/`retry`) or crudely derived (`has cloud_agent_session_id` → "active").
- When running 10+ sessions in parallel, there's no way to distinguish sessions that need attention (finished, errored, waiting for input) from ones still running or ones you're done with.

## Scope

**In scope**: Upgrade ChatSidebar with lifecycle-aware organization (open/archived), grouping, search, filtering, and more sessions. Add `archived_at` column to DB.
**Out of scope**: Removing the AppSidebar, changing route structure, merging pages, removing the Sessions page.

---

## Design

### Layout (unchanged)

```
┌───────────────────────────────────────────────────────────┐
│ AppSidebar │ ChatSidebar (320px)    │  Chat Area           │
│ (main nav) │ ┌────────────────────┐ │  ┌─────────────────┐ │
│            │ │ [+ New Session]    │ │  │ ChatHeader      │ │
│            │ │ [Open ▾] [🔍]     │ │  │                 │ │
│            │ │                    │ │  │ Messages        │ │
│            │ │ ● Session (busy)   │ │  │                 │ │
│            │ │ ○ Session (idle)   │ │  │                 │ │
│            │ │ ⚠ Session (error)  │ │  │                 │ │
│            │ │                    │ │  │                 │ │
│            │ │ ── owner/repo ──  │ │  │                 │ │
│            │ │  ▸ main (3)       │ │  │                 │ │
│            │ │  ▾ feat-x (1)     │ │  │                 │ │
│            │ │    Session title   │ │  │ ChatInput       │ │
│            │ │                    │ │  └─────────────────┘ │
│            │ └────────────────────┘ │                      │
└───────────────────────────────────────────────────────────┘
```

### ChatSidebar Enhancements

#### 1. Open / Archived tabs

The primary organizational axis. A tab or segmented control at the top:

- **Open** (default) — sessions you're actively working with. This is the main view.
- **Archived** — sessions you've dismissed. Hidden from the main list but retrievable.

"Archiving" sets `archived_at` on the DB row. This is a soft state change (not deletion). Users can unarchive.

**How sessions move between states:**
- New sessions start as "open" (`archived_at = NULL`)
- User explicitly archives via a swipe action, context menu, or button on the session card
- User can unarchive from the Archived tab
- No auto-archiving for now (keep it manual and predictable)

#### 2. Session activity indicators

For **open** sessions, show a live status indicator on each card. This requires polling or WebSocket-based status for sessions the user isn't currently viewing.

**Pragmatic approach for V1:** Since session status is only known client-side (via WebSocket to the active session's DO), we can't cheaply show live status for all sessions simultaneously. Instead:

- **Current session**: full live status from existing `sessionStatusAtom` (idle/busy/retry)
- **Other sessions**: show a lightweight indicator based on `updated_at` recency and `cloud_agent_session_id` presence:
  - Has `cloud_agent_session_id` + `updated_at` within last 10 minutes → likely active (pulsing dot)
  - Has `cloud_agent_session_id` + older `updated_at` → likely idle/finished (static dot)
  - No `cloud_agent_session_id` → CLI/external session (neutral)

**Future improvement**: Add a batch status endpoint that queries multiple DOs for their `sessionStatus` (idle/busy/error). This would give accurate multi-session status but is a larger backend change.

#### 3. More sessions + infinite scroll

Current: hardcoded `limit: 10` in `useSidebarSessions`.
After: increase initial fetch to 50, add cursor-based "load more" on scroll using the existing `unifiedSessions.list` endpoint (which already supports cursor pagination). The `list` endpoint needs to support filtering by `archived_at IS NULL` (open) vs `archived_at IS NOT NULL` (archived).

#### 4. Search

Add a debounced search input at the top of the sidebar. When active, switch to `unifiedSessions.search` endpoint (already exists). Show flat results when searching, regardless of view mode. Search operates within the current tab (open or archived).

#### 5. View mode toggle

A small segmented control or dropdown to switch between view modes. Persisted in `localStorage`. Available in both Open and Archived tabs.

- **Recent** (default) — flat chronological list, same as today but with more sessions
- **By Repository** — sessions grouped under collapsible repo headers (extracted from `git_url`)
- **By Branch** — two-level grouping: repo > branch > sessions

#### 6. Session grouping (client-side)

Grouping is done on the fetched session list. The `unifiedSessions.list` response already includes `git_url` and `git_branch` per session.

```
groupByRepo(sessions):
  "owner/repo-a"
    → [session1, session2, session3]
  "owner/repo-b"
    → [session4]
  "Ungrouped"
    → [session5]  // sessions with no git_url

groupByBranch(sessions):
  "owner/repo-a"
    "main"       → [session1, session2]
    "feat-x"     → [session3]
  "owner/repo-b"
    "main"       → [session4]
  "Ungrouped"
    ""           → [session5]
```

Repo groups and branch groups are collapsible. Each group header shows the count. Groups are sorted by most recent session within the group.

#### 7. Richer session cards

Current card: title + repo + time.
After: title + activity indicator (for open sessions) + branch badge (if available) + platform badge (Cloud/CLI/etc.) + relative time. Keep it compact since sidebar space is limited.

Archive/unarchive action: hover-reveal archive button (📥 icon) on each card.

#### 8. Platform filter (optional, lightweight)

A small filter icon/dropdown in the header area. Options: All / Cloud / CLI / Extension. Uses the existing `createdOnPlatform` param on `unifiedSessions.list`. Only show if user has sessions from multiple platforms.

---

## Implementation Plan

### Phase 1: Add `archived_at` column to DB

**DB migration**: Add `archived_at` (nullable timestamp) to both `cli_sessions` and `cli_sessions_v2` tables.

**File**: new migration in `packages/db/`
```sql
ALTER TABLE cli_sessions ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE cli_sessions_v2 ADD COLUMN archived_at TIMESTAMPTZ;
```

**File**: `packages/db/src/schema.ts`
- Add `archived_at` column to both table definitions

**File**: `src/routers/unified-sessions-router.ts`
- Add `archived_at` to the UNION column projections (`v1Columns`, `v2Columns`)
- Add `archived` boolean filter param to `ListSessionsInputSchema` and `SearchInputSchema`
- In `buildScopeFragments`, add `archived_at IS NULL` (default) or `archived_at IS NOT NULL` condition based on the filter

**File**: `src/routers/cli-sessions-v2-router.ts` (or new mutation)
- Add `archiveSession` mutation: sets `archived_at = NOW()` on the given session
- Add `unarchiveSession` mutation: sets `archived_at = NULL`
- (Or a single `setSessionArchived` mutation with a boolean flag)

### Phase 2: Expand session loading + preserve new fields

**File**: `src/components/cloud-agent-next/hooks/useSidebarSessions.ts`

- Increase `limit` from 10 to 50
- Return `nextCursor` from the hook
- Add a `fetchMore` function that loads the next page and appends results
- Add `archived` param (default `false`) to filter open vs archived
- Preserve `git_url`, `git_branch`, `created_on_platform`, `cloud_agent_session_id`, `updated_at` from the API response (currently discarded during mapping)

**File**: `src/components/cloud-agent-next/types.ts` or new type

- Extend `StoredSession` (or create a `SidebarSession` type) to include: `gitUrl`, `gitBranch`, `createdOnPlatform`, `cloudAgentSessionId`, `updatedAt`

### Phase 3: Open/Archived tabs + archive actions

**File**: `src/components/cloud-agent-next/ChatSidebar.tsx`

- Add tab bar at top: "Open" / "Archived"
- "Open" tab fetches with `archived: false`, "Archived" with `archived: true`
- Add archive button on session cards (hover-reveal, uses `archiveSession` mutation)
- Add unarchive button in Archived tab (same pattern)
- Invalidate sidebar query after archive/unarchive

### Phase 4: Add search to sidebar

**File**: `src/components/cloud-agent-next/ChatSidebar.tsx`

- Add search input with debounce (300ms)
- When search is active, call `trpc.unifiedSessions.search` instead of using the list data
- Pass `archived` filter to search as well
- Show flat results during search, ignoring view mode
- Clear search button

### Phase 5: Add view mode toggle and grouping

**File**: `src/components/cloud-agent-next/ChatSidebar.tsx`

- Add a view mode state: `'recent' | 'by-repo' | 'by-branch'`, persisted in localStorage
- Small toggle UI (segmented control or dropdown) below the tabs/search
- Implement `groupSessionsByRepo()` and `groupSessionsByBranch()` utility functions
- Render grouped sessions with collapsible headers (use `Collapsible` from shadcn/ui or a simple toggle)
- Group headers show: repo name (shortened from git_url), session count, most recent time
- Branch sub-headers show: branch name, session count

### Phase 6: Session activity indicators

**File**: `src/components/cloud-agent-next/ChatSidebar.tsx`

- For the currently active session: use existing `isStreaming` / `sessionStatusAtom` state (passed as prop)
- For other sessions: derive a lightweight indicator from `cloud_agent_session_id` + `updated_at`:
  - `cloud_agent_session_id` present + `updated_at` < 10 min ago → green pulsing dot ("likely active")
  - `cloud_agent_session_id` present + `updated_at` older → gray dot ("idle/done")
  - No `cloud_agent_session_id` → no indicator
- Render as a small colored dot on the session card, left of the title

### Phase 7: Richer session cards

**File**: `src/components/cloud-agent-next/ChatSidebar.tsx`

- Add branch badge (small tag with `GitBranch` icon) when `gitBranch` is available
- Add platform badge (tiny colored dot or icon) — reuse the platform badge logic from `SessionsList.tsx`
- Keep cards compact: max 2-3 lines

### Phase 8: Infinite scroll

**File**: `src/components/cloud-agent-next/ChatSidebar.tsx`

- Add an `IntersectionObserver` sentinel at the bottom of the session list
- When visible, call `fetchMore` from the hook
- Show a loading spinner while fetching
- Stop when `nextCursor` is null

### Phase 9: Platform filter (optional)

**File**: `src/components/cloud-agent-next/ChatSidebar.tsx`

- Add a filter icon button next to the search bar
- Dropdown with platform options
- Pass `createdOnPlatform` to the `useSidebarSessions` hook
- Re-fetch when filter changes

---

## API Changes

### Database

- Add `archived_at` column (nullable `TIMESTAMPTZ`) to `cli_sessions` and `cli_sessions_v2`
- Add index on `archived_at` for efficient filtering (partial index on `archived_at IS NULL` for the common "open" query)

### Unified Sessions Router (`src/routers/unified-sessions-router.ts`)

- Add `archived: z.boolean().optional().default(false)` to `ListSessionsInputSchema` and `SearchInputSchema`
- Add `archived_at` to UNION column projections
- Filter by `archived_at IS NULL` / `archived_at IS NOT NULL` in `buildScopeFragments`

### New mutations (on `cli-sessions-v2-router.ts` or a new `session-actions-router.ts`)

- `archiveSession({ sessionId: string })` — sets `archived_at = NOW()` on both V1 and V2 tables (try both, one will match)
- `unarchiveSession({ sessionId: string })` — sets `archived_at = NULL`

### Existing endpoints (no changes needed)

- `unifiedSessions.list` — already returns `git_url`, `git_branch`, `created_on_platform`
- `unifiedSessions.search` — already supports platform filter

---

## Files Changed Summary

| File | Change |
|---|---|
| `packages/db/` | New migration: add `archived_at` to both session tables |
| `packages/db/src/schema.ts` | Add `archived_at` column definitions |
| `src/routers/unified-sessions-router.ts` | Add `archived` filter, `archived_at` to projections |
| `src/routers/cli-sessions-v2-router.ts` (or new) | Add `archiveSession`/`unarchiveSession` mutations |
| `src/components/cloud-agent-next/ChatSidebar.tsx` | Major rewrite: tabs, search, view mode, grouping, activity indicators, cards, infinite scroll |
| `src/components/cloud-agent-next/hooks/useSidebarSessions.ts` | Increase limit, expose `fetchMore`/`nextCursor`, add `archived` param, preserve new fields |
| `src/components/cloud-agent-next/types.ts` | Add `gitUrl`, `gitBranch`, `createdOnPlatform`, `cloudAgentSessionId`, `updatedAt` to session type |
| `src/components/cloud-agent-next/CloudChatContainer.tsx` | Pass new sidebar props (archive callback, current session status) |
| `src/components/cloud-agent-next/CloudChatPresentation.tsx` | Pass through new sidebar props |

No files deleted. No route changes. No layout changes.

---

## Open Questions

1. **Group collapse state**: Should expanded/collapsed state of repo/branch groups persist across navigations? Simplest: default all collapsed except the group containing the active session. Could persist in localStorage if needed.

2. **Mixed V1/V2 in branch view**: V1 sessions have `git_branch: null`. In "By Branch" view, these appear under a "(no branch)" sub-group within their repo. Alternatively, skip the branch level for V1 sessions and show them directly under the repo header.

3. **Search scope**: Search currently matches title and session ID. Could extend to match repo name or branch name for better discoverability. This would be a backend change (add `git_url ILIKE` and `git_branch ILIKE` to the search query).

4. **Sidebar width**: The current 320px (`w-80`) may feel tight with grouped content. Monitor in practice. Could consider making it slightly wider (e.g., `w-84` / 336px) if grouping headers feel cramped.

5. **Performance with 50+ sessions**: Client-side grouping of 50-100 sessions is cheap. If users have thousands of sessions, the cursor-based pagination ensures we never load them all at once. The grouping only operates on currently-loaded sessions.

6. **Accurate multi-session status**: The heuristic-based activity indicator (based on `updated_at` recency) is approximate. For accurate live status across all open sessions, we'd need a batch DO status endpoint. This is deferred as a future improvement.

7. **Auto-archiving**: Could auto-archive sessions after N days of inactivity, or after a session reaches a "completed" state. Deferred — start with manual archiving and see if users want automation.

8. **GDPR**: `archived_at` is not PII — it's a timestamp on a session row, not user-identifying data. No changes needed to `softDeleteUser`. (The existing session deletion in `softDeleteUser` will naturally handle archived sessions since it deletes the row entirely.)
