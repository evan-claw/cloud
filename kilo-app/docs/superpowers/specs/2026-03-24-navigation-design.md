# Navigation Design — Kilo App

## Overview

Chat-first mobile app with 2-tab navigation. KiloClaw Chat is the primary experience; Cloud Agents is secondary. Profile and KiloClaw Dashboard are accessed via header actions, not tabs.

## Auth & Context Gate

The root layout implements a 3-way redirect. The splash screen remains visible until both auth and context have loaded from SecureStore.

| State | Destination |
|-------|-------------|
| No token | `(auth)/login` |
| Token, no context | `(context)/select` |
| Token + context | `(app)/` |

**Context** is either `"personal"` or an org ID. Stored in `expo-secure-store` alongside the auth token. Selected after first login and persisted across sessions.

**Combined loading gate**: `isLoading = authIsLoading || contextIsLoading`. No redirect decisions are made until both resolve, preventing a flash to the context picker while context loads from SecureStore.

## Route Structure

```
src/app/
├── _layout.tsx                        # Root: providers + 3-way redirect
├── (auth)/
│   ├── _layout.tsx                    # Slot
│   └── login.tsx                      # Device auth flow
├── (context)/
│   ├── _layout.tsx                    # Slot
│   └── select.tsx                     # Personal / org picker
└── (app)/
    ├── _layout.tsx                    # Stack (wraps tabs + modal screens)
    ├── profile.tsx                    # Modal screen (presentation: 'modal', href: null)
    └── (tabs)/
        ├── _layout.tsx                # Tabs navigator (2 tabs)
        ├── (kiloclaw)/
        │   ├── _layout.tsx            # Stack
        │   ├── index.tsx              # Instance list (landing screen)
        │   └── [instanceId]/
        │       ├── index.tsx          # Chat
        │       └── dashboard.tsx      # Instance management (via ⚙️)
        └── (agents)/
            ├── _layout.tsx            # Stack
            ├── index.tsx              # Agent sessions list
            └── [sessionId].tsx        # Session detail / chat
```

**`(app)/_layout.tsx`** is a `Stack` navigator, not `Tabs` directly. It renders the `(tabs)` group as one screen and `profile` as a sibling with `presentation: 'modal'`. This lets Profile be presented as a modal from any tab without crossing tab boundaries. The actual tab bar lives in `(tabs)/_layout.tsx`.

## Tab Bar

Two tabs, always visible at the list-level screens:

| Tab | Icon | Label | Landing Screen |
|-----|------|-------|----------------|
| KiloClaw | 💬 | KiloClaw | Instance list |
| Agents | 🤖 | Agents | Sessions list |

**Tab bar hiding in chat**: Set `tabBarStyle: { display: 'none' }` on chat/detail screens via `navigation.setOptions()` in a `useLayoutEffect`, or via static screen options in the Stack `_layout.tsx`. This is the simplest Expo Router approach. If the layout jump is noticeable, upgrade to a custom animated tab bar later.

## Screen Inventory

### KiloClaw Tab (Stack)

**Instance List** (`(kiloclaw)/index.tsx`)
- Lists user's KiloClaw instances with name, status (running/stopped), last message preview
- Header: app title left, avatar icon top-right (→ Profile modal)
- Tap instance → Chat
- Empty state: message directing users to set up an instance on the web dashboard

**Chat** (`(kiloclaw)/[instanceId]/index.tsx`)
- Message thread with the selected instance
- Header: instance name, ⚙️ icon (→ Dashboard), back arrow
- Full chat interface — input bar, message bubbles, etc.

**Dashboard** (`(kiloclaw)/[instanceId]/dashboard.tsx`)
- Instance management: restart, token setup, status, logs
- Mirrors web dashboard functionality
- Header: "Dashboard" title, back arrow (→ Chat)

### Agents Tab (Stack)

**Sessions List** (`(agents)/index.tsx`)
- Lists cloud agent sessions with status, timestamps
- Header: "Agents" title, avatar icon top-right (→ Profile modal)
- Tap session → Session Detail
- Empty state: message explaining cloud agents with link to web

**Session Detail** (`(agents)/[sessionId].tsx`)
- Session chat/output, mirrors web experience
- Header: session name, back arrow (→ Sessions List)

### Profile (Modal)

**Profile** (`(app)/profile.tsx`)
- Presented as a modal from any screen via avatar icon in header
- User info, linked auth providers
- Current context displayed (personal or org name)
- "Switch Context" action → triggers context switch flow
- "Sign Out" action → clears both token and context, redirects to login

## State Architecture

### Provider Nesting (Root Layout)

```
GestureHandlerRootView
  → TRPCProvider
    → QueryClientProvider
      → AuthProvider              # token, signIn(), signOut()
        → ContextProvider         # context, setContext(), clearContext()
          → Slot
```

`QueryClientProvider` must be an ancestor of anything that calls `useQuery`, so it wraps the auth/context providers. The tRPC client reads token and context from SecureStore directly in its `headers()` function (not from React context), keeping it decoupled from the provider tree.

### ContextProvider

- Stores selected context (org ID or `"personal"`) in `expo-secure-store` under key `'app-context'`
- Exposes: `context`, `isLoading`, `setContext(ctx)`, `clearContext()`
- On `clearContext()`: clears stored value + calls `queryClient.clear()` (removes all cached data, not just invalidation — prevents stale data from a previous org context being visible)
- Root layout reads `context` to decide redirect target

### Context Picker Data

The `(context)/select` screen fetches the user's organizations via tRPC. The exact endpoint depends on what the backend exposes (likely `user.getOrganizations` or similar — verify during implementation). Expected shape: array of `{ id: string; name: string }`. "Personal" is always available as an option regardless of the API response. If the user has zero orgs, the picker shows only the personal option. Loading and error states should be handled with standard patterns (skeleton + retry).

### Context Switch Flow

1. User taps "Switch Context" in Profile
2. `clearContext()` called — clears secure store + React Query cache
3. Root layout detects `token && !context` → redirects to `(context)/select`
4. User selects new context → `setContext(ctx)`
5. Root layout detects `token && context` → redirects to `(app)/`
6. App component tree remounts fresh, all queries refetch with new context

### Sign Out Flow

`signOut()` deletes both the `auth-token` and `app-context` keys from SecureStore directly (no provider coupling needed — SecureStore is a simple key-value API), then calls `queryClient.clear()`. `ContextProvider` detects the missing value on next mount. This prevents a subsequent user on the same device from inheriting a previous user's org context.

### tRPC Integration

- The tRPC client's `headers()` function reads both the auth token and context from SecureStore (not React context)
- Sends `Authorization: Bearer {token}` and `X-Context-Id: {contextId}` headers
- All queries are scoped to the active context server-side

## Navigation Patterns

- **Stacks within tabs**: Each tab owns a Stack navigator for push/pop navigation
- **Profile as modal**: Presented from `(app)` root level, accessible from any tab
- **Tab bar visibility**: Visible at list screens, hidden during chat/detail screens
- **Single instance optimization**: If user has one instance, can optionally skip the list and navigate directly to chat (future enhancement)

## Deep Linking

Deferred to a future spec. Will need to handle:
- Unauthenticated users (queue link, redirect after auth + context selection)
- Context validation (does the user have access to the linked resource in their current context?)
- Routes for both tabs (`kiloapp://kiloclaw/:instanceId`, `kiloapp://agents/:sessionId`)
- URL scheme registration in `app.config.ts`

## Future Considerations

- **Status header (Chat → C pattern)**: Instance health/status bar at the top of the chat screen — easy addition without restructuring
- **Tab promotion**: If Agents becomes higher priority, it's already a full tab — no changes needed
- **Additional tabs**: Room to grow to 3-4 tabs. Profile could become its own tab if needed
- **Dashboard as secondary path**: Instance picker could show a "manage" action alongside "chat" — not mutually exclusive with the ⚙️ header approach
- **Agent session sub-screens**: If session detail needs child routes, restructure `[sessionId].tsx` into `[sessionId]/index.tsx` directory pattern
