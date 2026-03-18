# Cloud Sessions UI Redesign

## Goal

Improve the session browsing experience in the existing ChatSidebar. Keep the current 3-column layout (AppSidebar + ChatSidebar + Chat) and route structure intact. Focus on making sessions discoverable — groupable by project/branch, searchable, and filterable — within the existing sidebar.

## Current State

- **ChatSidebar** (`src/components/cloud-agent-next/ChatSidebar.tsx`): flat list of 10 most recent sessions, no search, no filtering, no grouping. Each card shows title, repo, and time.
- **Sessions page** (`/cloud/sessions`): separate page with search, platform filter, and sub-session toggle — but uses a modal dialog to open sessions.
- Sessions have `git_url` and `git_branch` (V2 only) fields that are unused for grouping.

## Scope

**In scope**: Upgrade ChatSidebar with grouping, search, filtering, and more sessions.
**Out of scope**: Removing the AppSidebar, changing route structure, merging pages, removing the Sessions page.

---

## Design

### Layout (unchanged)

```
┌───────────────────────────────────────────────────────────┐
│ AppSidebar │ ChatSidebar (320px)    │  Chat Area           │
│ (main nav) │ ┌────────────────────┐ │  ┌─────────────────┐ │
│            │ │ [+ New Session]    │ │  │ ChatHeader      │ │
│            │ │ [🔍 Search...]    │ │  │                 │ │
│            │ │ View: [Recent ▾]  │ │  │ Messages        │ │
│            │ │                    │ │  │                 │ │
│            │ │ ── owner/repo ──  │ │  │                 │ │
│            │ │  ▸ main (3)       │ │  │                 │ │
│            │ │  ▾ feat-x (1)     │ │  │                 │ │
│            │ │    Session title   │ │  │                 │ │
│            │ │                    │ │  │ ChatInput       │ │
│            │ │ ── Ungrouped ──   │ │  └─────────────────┘ │
│            │ │    Session title   │ │                      │
│            │ └────────────────────┘ │                      │
└───────────────────────────────────────────────────────────┘
```

### ChatSidebar Enhancements

#### 1. More sessions + infinite scroll

Current: hardcoded `limit: 10` in `useSidebarSessions`.
After: increase initial fetch to 50, add cursor-based "load more" on scroll using the existing `unifiedSessions.list` endpoint (which already supports cursor pagination).

#### 2. Search

Add a debounced search input at the top of the sidebar. When active, switch to `unifiedSessions.search` endpoint (already exists). Show flat results when searching, regardless of view mode.

#### 3. View mode toggle

A small segmented control or dropdown to switch between view modes. Persisted in `localStorage`.

- **Recent** (default) — flat chronological list, same as today but with more sessions
- **By Repository** — sessions grouped under collapsible repo headers (extracted from `git_url`)
- **By Branch** — two-level grouping: repo > branch > sessions

#### 4. Session grouping (client-side)

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

#### 5. Richer session cards

Current card: title + repo + time.
After: title + branch badge (if available) + platform badge (Cloud/CLI/etc.) + relative time. Keep it compact since sidebar space is limited.

#### 6. Platform filter (optional, lightweight)

A small filter icon/dropdown in the header area. Options: All / Cloud / CLI / Extension. Uses the existing `createdOnPlatform` param on `unifiedSessions.list`. Only show if user has sessions from multiple platforms.

---

## Implementation Plan

### Phase 1: Expand session loading

**File**: `src/components/cloud-agent-next/hooks/useSidebarSessions.ts`

- Increase `limit` from 10 to 50
- Return `nextCursor` from the hook
- Add a `fetchMore` function that loads the next page and appends results
- Add the `git_url`, `git_branch`, and `created_on_platform` fields to the sidebar session type (they're already returned by the API but currently mapped out in `convertToStoredSession`)

**File**: `src/components/cloud-agent-next/types.ts` or a new type

- Extend `StoredSession` (or create a `SidebarSession` type) to include `gitUrl`, `gitBranch`, `createdOnPlatform` fields

### Phase 2: Add search to sidebar

**File**: `src/components/cloud-agent-next/ChatSidebar.tsx`

- Add search input with debounce (300ms)
- When search is active, call `trpc.unifiedSessions.search` instead of using the list data
- Show flat results during search, ignoring view mode
- Clear search button

### Phase 3: Add view mode toggle and grouping

**File**: `src/components/cloud-agent-next/ChatSidebar.tsx`

- Add a view mode state: `'recent' | 'by-repo' | 'by-branch'`, persisted in localStorage
- Small toggle UI (segmented control or dropdown) below the search bar
- Implement `groupSessionsByRepo()` and `groupSessionsByBranch()` utility functions
- Render grouped sessions with collapsible headers (use `Collapsible` from shadcn/ui or a simple toggle)
- Group headers show: repo name (shortened from git_url), session count, most recent time
- Branch sub-headers show: branch name, session count

### Phase 4: Richer session cards

**File**: `src/components/cloud-agent-next/ChatSidebar.tsx`

- Add branch badge (small tag with `GitBranch` icon) when `gitBranch` is available
- Add platform badge (tiny colored dot or icon) — reuse the platform badge logic from `SessionsList.tsx`
- Keep cards compact: max 2-3 lines

### Phase 5: Infinite scroll

**File**: `src/components/cloud-agent-next/ChatSidebar.tsx`

- Add an `IntersectionObserver` sentinel at the bottom of the session list
- When visible, call `fetchMore` from the hook
- Show a loading spinner while fetching
- Stop when `nextCursor` is null

### Phase 6: Platform filter (optional)

**File**: `src/components/cloud-agent-next/ChatSidebar.tsx`

- Add a filter icon button next to the search bar
- Dropdown with platform options
- Pass `createdOnPlatform` to the `useSidebarSessions` hook
- Re-fetch when filter changes

---

## API Changes

**None required.** The existing `unifiedSessions.list` endpoint already supports:
- `limit` up to 50 (already validated, just need to pass a larger value)
- `cursor` for pagination
- `createdOnPlatform` filter
- Returns `git_url`, `git_branch`, `created_on_platform` per session

The `unifiedSessions.search` endpoint already supports:
- `search_string` with ILIKE matching
- `createdOnPlatform` filter
- Pagination via `limit`/`offset`

Only change: the client needs to preserve `git_url` and `git_branch` from the API response instead of discarding them during the `convertToStoredSession` mapping.

---

## Files Changed Summary

| File | Change |
|---|---|
| `src/components/cloud-agent-next/ChatSidebar.tsx` | Major rewrite: add search, view mode toggle, grouping, richer cards, infinite scroll |
| `src/components/cloud-agent-next/hooks/useSidebarSessions.ts` | Increase limit, expose `fetchMore`/`nextCursor`, preserve git_url/git_branch fields |
| `src/components/cloud-agent-next/types.ts` | Add `gitUrl`, `gitBranch`, `createdOnPlatform` to session type (or new `SidebarSession` type) |
| `src/components/cloud-agent-next/CloudChatContainer.tsx` | Pass new sidebar props (search, view mode, filter state) if managed at container level |
| `src/components/cloud-agent-next/CloudChatPresentation.tsx` | Pass through new sidebar props |

No files deleted. No route changes. No layout changes.

---

## Open Questions

1. **Group collapse state**: Should expanded/collapsed state of repo/branch groups persist across navigations? Simplest: default all collapsed except the group containing the active session. Could persist in localStorage if needed.

2. **Mixed V1/V2 in branch view**: V1 sessions have `git_branch: null`. In "By Branch" view, these appear under a "(no branch)" sub-group within their repo. Alternatively, skip the branch level for V1 sessions and show them directly under the repo header.

3. **Search scope**: Search currently matches title and session ID. Could extend to match repo name or branch name for better discoverability. This would be a backend change (add `git_url ILIKE` and `git_branch ILIKE` to the search query).

4. **Sidebar width**: The current 320px (`w-80`) may feel tight with grouped content. Monitor in practice. Could consider making it slightly wider (e.g., `w-84` / 336px) if grouping headers feel cramped.

5. **Performance with 50+ sessions**: Client-side grouping of 50-100 sessions is cheap. If users have thousands of sessions, the cursor-based pagination ensures we never load them all at once. The grouping only operates on currently-loaded sessions.
