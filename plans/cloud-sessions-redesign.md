# Cloud Sessions UI Redesign

## Goal

Merge the separate "Cloud Agent" (`/cloud`) and "Sessions" (`/cloud/sessions`) pages into a single unified interface. Eliminate the 3-column layout problem. Make sessions easy to browse, group by project/branch, and view inline without pop-ups.

## Current State

- **3 separate pages**: `/cloud` (new session form), `/cloud/chat?sessionId=X` (chat view with its own ChatSidebar), `/cloud/sessions` (flat session list with "Open Session" dialog)
- **3-column problem**: AppSidebar (256px) + ChatSidebar (320px) + Chat area on the chat page
- **Session list is flat**: no grouping by repository or branch
- **Sessions page uses a modal dialog** to open/fork sessions — cumbersome
- **ChatSidebar** only shows 10 most recent sessions with no filtering/search

## Design Decisions

1. **Hide AppSidebar entirely** on all `/cloud/*` pages — accessible via hamburger menu or overlay
2. **Inline "New Session" form** — clicking "New Session" replaces the chat content area (Claude-like)
3. **Flexible session grouping** — sidebar supports multiple view modes (recent, by-repo, by-branch)
4. **Single page** — everything under `/cloud` with session selection via query param

---

## Architecture

### Layout: 2-Column (Sidebar + Content)

```
┌──────────────────────────────────────────────────────┐
│ CloudAgentSidebar (320px)  │  Content Area            │
│ ┌────────────────────────┐ │  ┌──────────────────────┐│
│ │ [≡ Menu] Cloud Agent   │ │  │ ChatHeader / Form    ││
│ │ [+ New Session]        │ │  │                      ││
│ │                        │ │  │ Messages / New       ││
│ │ View: [Recent ▾]      │ │  │ Session Form         ││
│ │ [🔍 Search...]        │ │  │                      ││
│ │                        │ │  │                      ││
│ │ ── owner/repo ──       │ │  │                      ││
│ │   ├ main               │ │  │                      ││
│ │   │  Session title...  │ │  │                      ││
│ │   │  Session title...  │ │  │                      ││
│ │   └ feature-branch     │ │  │                      ││
│ │      Session title...  │ │  │                      ││
│ │                        │ │  │ ChatInput            ││
│ │ ── other/repo ──       │ │  └──────────────────────┘│
│ │   Session title...     │ │                          │
│ └────────────────────────┘ │                          │
└──────────────────────────────────────────────────────┘
```

- No AppSidebar visible. A hamburger icon in the sidebar header opens the main nav as an overlay/sheet.
- Sidebar is the session browser with filtering and grouping.
- Content area shows either the chat view or the new session form.

### Route Structure

Keep existing routes but unify behavior:

| Route | Content Area | Sidebar |
|---|---|---|
| `/cloud` | New session form (inline) | CloudAgentSidebar |
| `/cloud?sessionId=X` or `/cloud/chat?sessionId=X` | Chat view | CloudAgentSidebar (session X highlighted) |

Both routes render the same layout component. The presence of `sessionId` determines whether to show the form or the chat.

> **Note**: We can support both `/cloud?sessionId=X` and `/cloud/chat?sessionId=X` during migration, eventually deprecating the latter.

---

## Detailed Changes

### Phase 1: Hide AppSidebar on Cloud Pages

**Files**: `src/app/(app)/components/AppSidebar.tsx`, `src/app/(app)/layout.tsx`

1. In `AppSidebar.tsx`, detect `/cloud` pathname prefix (similar to the Gastown `extractGastownTownId` pattern).
2. When on a `/cloud/*` route, return `null` from `AppSidebar` — this removes the main nav sidebar entirely.
3. In the `(app)/layout.tsx`, the `SidebarInset` wrapper will naturally fill the space since there's no sidebar.
4. Add a "hamburger" trigger in the `CloudAgentSidebar` header that opens the main nav as a `Sheet` overlay (similar to mobile pattern already used).

```tsx
// AppSidebar.tsx addition
function isCloudRoute(pathname: string): boolean {
  return pathname === '/cloud' || pathname.startsWith('/cloud/');
}

export default function AppSidebar(props) {
  const pathname = usePathname();
  
  // Cloud pages manage their own sidebar
  if (isCloudRoute(pathname)) return null;
  
  // ... existing gastown/org/personal logic
}
```

Also handle org-scoped cloud routes: `/organizations/[id]/cloud/*`.

### Phase 2: New CloudAgentSidebar Component

**New file**: `src/components/cloud-agent-next/CloudAgentSidebar.tsx`

This replaces the current `ChatSidebar.tsx` with a full-featured session browser.

**Header section**:
- Hamburger icon → opens main nav as Sheet overlay
- "Cloud Agent" title
- "+ New Session" button (navigates to `/cloud` or sets internal state to show form)

**View mode toggle** (stored in localStorage):
- **Recent** — flat chronological list (current behavior, default)
- **By Repository** — grouped by `git_url`, collapsible repo sections
- **By Branch** — within each repo group, further grouped by `git_branch`

**Search bar**: 
- Debounced search input (reuse existing `trpc.unifiedSessions.search`)
- When searching, always show flat results regardless of view mode

**Session list**:
- Loads more sessions than the current 10 limit (paginated, load-more on scroll)
- Each session card shows: title (truncated), branch badge, relative time, platform badge
- Clicking a session navigates to `/cloud/chat?sessionId=X` (or updates query param)
- Hover-reveal delete button (existing `InlineDeleteConfirmation` pattern)
- Active session highlighted

**Platform filter** (optional, collapsed under a filter icon):
- All / Cloud / CLI / Agent Manager / Extension
- Replaces the current Sessions page filter dropdowns

**Grouping logic** (client-side, from fetched sessions):

```tsx
type GroupedSessions = {
  // key: repo full name (e.g., "owner/repo"), or "No Repository" for null git_url
  [repoName: string]: {
    // key: branch name, or "default" for null git_branch
    [branchName: string]: UnifiedSession[];
  };
};
```

Sessions are fetched via the existing `trpc.unifiedSessions.list` endpoint (increase limit to 100 or use cursor-based infinite scroll). Grouping is done client-side since the data already contains `git_url` and `git_branch`.

### Phase 3: Unified Cloud Layout

**New file**: `src/app/(app)/cloud/layout.tsx` (replace current minimal auth-only layout)

This layout wraps all `/cloud/*` pages with the 2-column structure:

```tsx
export default function CloudLayout({ children }) {
  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <CloudAgentSidebar />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
```

The `children` slot receives either:
- The new session form (`/cloud` page)
- The chat view (`/cloud/chat` page)

### Phase 4: Inline New Session Form

**Modified file**: `src/components/cloud-agent-next/CloudNextSessionsPage.tsx`

- Remove `PageLayout` wrapper (no longer needed — the cloud layout provides structure)
- Style as an inline content view that fits within the chat content area
- Keep all existing functionality (repo picker, prompt, mode/model, profiles, etc.)
- After session creation, navigate to `/cloud/chat?sessionId=X` — the sidebar automatically reflects the new session

### Phase 5: Remove Old Sessions Page & Dialog

**Remove/deprecate**:
- `src/app/(app)/cloud/sessions/SessionsPageContent.tsx` — functionality moved to CloudAgentSidebar
- `src/app/(app)/cloud/sessions/page.tsx` — no longer needed as separate page
- The "Open Session" `Dialog` in SessionsPageContent — replaced by direct inline navigation
- Remove `Sessions` entry from PersonalAppSidebar and OrganizationAppSidebar menu lists

**Keep** (referenced by sidebar):
- `src/components/cloud-agent/SessionsList.tsx` — may be reused or adapted for sidebar cards
- `src/routers/unified-sessions-router.ts` — backend stays the same

### Phase 6: Remove ChatSidebar from CloudChatPresentation

**Modified file**: `src/components/cloud-agent-next/CloudChatPresentation.tsx`

- Remove the desktop `ChatSidebar` div (`<div className="hidden w-80 border-r lg:block">`)
- Remove the mobile `Sheet` wrapping `ChatSidebar`
- Remove `ChatSidebar` import and all related props (`sessions`, `onNewSession`, `onSelectSession`, `onDeleteSession`, `mobileSheetOpen`, `onMobileSheetOpenChange`, `onMenuClick`)
- The chat presentation becomes purely about the chat — header, messages, input
- The sidebar is now handled by the layout, not the chat component

**Modified file**: `src/components/cloud-agent-next/CloudChatContainer.tsx`
- Remove `useSidebarSessions` hook usage
- Remove sidebar-related state management
- Simplify props passed to `CloudChatPresentation`

### Phase 7: Mobile Responsive

- On mobile (`< lg`), the sidebar becomes a Sheet (slide-out drawer) — same pattern as current mobile ChatSidebar
- The hamburger icon in the content header toggles the sidebar Sheet
- This mirrors how the current AppSidebar becomes a Sheet on mobile

### Phase 8: Organization-Scoped Routes

Apply the same changes to `/organizations/[id]/cloud/*` routes:
- Same sidebar hiding logic in AppSidebar for org cloud routes
- Same CloudLayout applied to org cloud routes
- CloudAgentSidebar receives `organizationId` prop for scoped queries

---

## API Changes

### Unified Sessions Router

**Existing endpoint enhancements** (`src/routers/unified-sessions-router.ts`):

1. **Increase default page size** for sidebar: allow `limit` up to 100 for the sidebar use case
2. **No new grouping endpoint needed** — grouping by `git_url`/`git_branch` is done client-side from the flat list
3. The existing `list` and `search` endpoints already return `git_url`, `git_branch`, `created_on_platform` — all data needed for grouping and filtering

No backend changes required for the core functionality.

---

## Component Dependency Graph (After)

```
(app)/layout.tsx
  └─ AppSidebar (returns null on /cloud/*)
  └─ SidebarInset > main
       └─ cloud/layout.tsx
            ├─ CloudAgentSidebar (new, always visible)
            │   ├─ MainNavSheet (hamburger → overlay with main nav)
            │   ├─ NewSessionButton
            │   ├─ ViewModeToggle (recent / by-repo / by-branch)
            │   ├─ SearchInput
            │   ├─ PlatformFilter
            │   └─ SessionList (grouped or flat based on view mode)
            │
            └─ Content area (children)
                 ├─ /cloud → CloudNextSessionsPage (inline form, no PageLayout)
                 └─ /cloud/chat → CloudChatPresentation (no internal sidebar)
```

---

## Files Changed Summary

| File | Change |
|---|---|
| `src/app/(app)/components/AppSidebar.tsx` | Return `null` for `/cloud/*` and `/organizations/*/cloud/*` routes |
| `src/app/(app)/cloud/layout.tsx` | New unified layout with CloudAgentSidebar + content area |
| `src/components/cloud-agent-next/CloudAgentSidebar.tsx` | **New** — full session browser sidebar |
| `src/components/cloud-agent-next/CloudChatPresentation.tsx` | Remove internal sidebar, mobile sheet, related props |
| `src/components/cloud-agent-next/CloudChatContainer.tsx` | Remove sidebar session fetching, simplify |
| `src/components/cloud-agent-next/CloudNextSessionsPage.tsx` | Remove PageLayout wrapper, adapt for inline display |
| `src/components/cloud-agent-next/ChatSidebar.tsx` | **Delete** — replaced by CloudAgentSidebar |
| `src/app/(app)/cloud/sessions/SessionsPageContent.tsx` | **Delete** — functionality in sidebar |
| `src/app/(app)/cloud/sessions/page.tsx` | Redirect to `/cloud` or delete |
| `src/app/(app)/components/PersonalAppSidebar.tsx` | Remove "Sessions" menu item (optional: keep as link to `/cloud`) |
| `src/app/(app)/components/OrganizationAppSidebar.tsx` | Remove "Sessions" menu item |
| Org-scoped cloud routes (`organizations/[id]/cloud/*`) | Apply same layout pattern |

---

## Open Questions / Risks

1. **Session list performance**: Loading 100+ sessions for client-side grouping could be slow. Mitigation: start with cursor-based pagination, load first 50 eagerly, lazy-load more on scroll.

2. **V1 sessions without git_branch**: These appear under a "No branch" sub-group within their repo group, or directly under the repo header in "By Repository" view mode.

3. **Sessions without git_url**: Grouped under an "Ungrouped" or "No Repository" section at the bottom.

4. **Main nav accessibility**: With AppSidebar hidden, users need the hamburger → Sheet overlay to access other areas. This is acceptable since cloud agent is a focused workflow, similar to how Gastown works. The hamburger is always visible in the sidebar header.

5. **Deep links**: `/cloud/sessions` should redirect to `/cloud` to avoid dead links. `/cloud/chat?sessionId=X` continues to work.

6. **"Cloud Agent" vs "Sessions" sidebar entry**: The PersonalAppSidebar currently has separate entries for "Cloud Agent" and "Sessions". After unification, only "Cloud Agent" is needed (pointing to `/cloud`). Consider renaming to just "Sessions" or keeping "Cloud Agent" depending on branding preference.
