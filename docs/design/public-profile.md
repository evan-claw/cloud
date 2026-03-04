# Public Profile Feature

A public-facing profile page for Kilo Cloud users that displays feature usage activity, styled with retro Altair 8800 computing aesthetics and modern GitHub-profile-like elements.

---

## Problem Statement

1. Users have no way to publicly share or showcase their Kilo usage and activity.
2. The existing `/profile` page is authenticated-only and focused on account management (credits, billing, integrations), not activity visualization.
3. There is no GitHub-profile-style "contribution graph" or feature-usage summary that users can link to from their portfolio, README, or social media.
4. Usage data exists in `microdollar_usage_metadata` but is not aggregated or cached in a way suitable for public page performance.

---

## Design Principles

1. **Performance first.** A public page will be crawled and shared widely. It must load fast without hitting expensive aggregate queries on every request.
2. **Privacy by default.** Users opt in to making their profile public and control what is visible. Nothing is exposed without explicit consent.
3. **Existing data, no new instrumentation.** The `microdollar_usage_metadata` table already tracks `feature_id` for every request across all 11 features — we aggregate from what exists.
4. **Retro aesthetic, modern UX.** The visual design draws from the Altair 8800 front panel (LED indicators, toggle switches, label plates) while maintaining the usability standards of a modern web profile page.

---

## Features Tracked

The profile displays usage activity for 11 features, all already tracked via the `feature` lookup table referenced by `microdollar_usage_metadata.feature_id`:

| # | Profile Label | `feature` table value(s) | Description |
|---|---|---|---|
| 1 | VSCode | `vscode-extension` | VS Code extension usage |
| 2 | CLI | `cli` | Command-line interface usage |
| 3 | JetBrains | `jetbrains-extension` | JetBrains IDE extension usage |
| 4 | Cloud Agents | `cloud-agent` | Cloud agent sessions |
| 5 | App Builder | `app-builder` | App Builder usage |
| 6 | Kilo Bot | `slack`, `discord`, `webhook` | Bot interactions across platforms |
| 7 | Code Reviews | `code-review` | Automated code review usage |
| 8 | Kilo Gateway | `direct-gateway` | Direct gateway API calls |
| 9 | Agent Manager | `agent-manager` | Agent management operations |
| 10 | KiloClaw | `kiloclaw`, `openclaw` | KiloClaw compute usage |
| 11 | Security Agent | `security-agent` | Security analysis usage |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Public Internet                          │
│                                                              │
│   GET /u/{username}          GET /api/public-profile/{uid}   │
│         │                            │                       │
└─────────┼────────────────────────────┼───────────────────────┘
          │                            │
          ▼                            ▼
┌──────────────────┐       ┌────────────────────────┐
│  Next.js Page    │──────►│  API Route / tRPC      │
│  (SSR or ISR)    │       │  publicProfile.get      │
└──────────────────┘       └────────────┬───────────┘
                                        │
                                        ▼
                           ┌────────────────────────┐
                           │  user_period_cache      │
                           │  (cache_type =          │
                           │   'public_profile')     │
                           └────────────┬───────────┘
                                        │
                              cache miss / stale
                                        │
                                        ▼
                           ┌────────────────────────┐
                           │  Aggregation Query      │
                           │  microdollar_usage +    │
                           │  microdollar_usage_     │
                           │  metadata               │
                           └────────────────────────┘
```

---

## Data Layer

### Source Tables (existing)

- **`microdollar_usage`** — Core usage record: `kilo_user_id`, `cost`, `input_tokens`, `output_tokens`, `created_at`, `model`, `provider`.
- **`microdollar_usage_metadata`** — Request metadata: `feature_id`, `editor_name_id`, `created_at`. Joined to `microdollar_usage` by shared `id`.
- **`feature`** — Lookup table mapping `feature_id` → feature name string (e.g., `'vscode-extension'`, `'cloud-agent'`).

### Cache Table (existing)

The `user_period_cache` table already exists in the schema with the exact structure needed:

```typescript
user_period_cache = pgTable('user_period_cache', {
  id:               uuid().primaryKey(),
  kilo_user_id:     text().notNull(),       // FK → kilocode_users.id
  cache_type:       text().notNull(),       // 'public_profile'
  period_type:      text().notNull(),       // 'month', 'week', 'year'
  period_key:       text().notNull(),       // '2025-06', '2025-W23', '2025'
  data:             jsonb().notNull(),       // Aggregated profile data
  computed_at:      timestamp().notNull(),
  version:          integer().default(1),

  // Shareability (already built in)
  shared_url_token: text(),                 // Random token for public URL
  shared_at:        timestamp(),
});
// Unique constraint: (kilo_user_id, cache_type, period_type, period_key)
// Partial unique index on shared_url_token WHERE NOT NULL
```

This table already has shareability columns (`shared_url_token`, `shared_at`) with a partial unique index — it was designed for exactly this kind of feature. No schema migration is needed for the cache layer.

### Cache `data` Schema

The `data` JSONB column for `cache_type = 'public_profile'` stores a snapshot of per-feature activity:

```typescript
type PublicProfileData = {
  schema_version: 1
  username: string
  display_name: string | null
  avatar_url: string | null
  github_url: string | null
  linkedin_url: string | null
  member_since: string                       // ISO date

  features: {
    feature_key: string                      // e.g. 'vscode-extension'
    label: string                            // e.g. 'VSCode'
    request_count: number                    // Total requests in period
    total_tokens: number                     // input + output tokens
    first_used: string | null                // ISO date
    last_used: string | null                 // ISO date
    active_days: number                      // Distinct days with usage
  }[]

  activity_heatmap: {
    date: string                             // ISO date (YYYY-MM-DD)
    request_count: number
  }[]                                        // Last 365 days, sparse

  totals: {
    total_requests: number
    total_tokens: number
    total_active_days: number
    longest_streak: number                   // Consecutive active days
    current_streak: number
  }
}
```

### What is NOT exposed

The following data from `microdollar_usage` is intentionally excluded from the public profile:

- **Cost / microdollars** — Financial data stays private.
- **Model names / providers** — Internal infrastructure detail.
- **IP addresses, user agents, geolocation** — PII from `microdollar_usage_metadata`.
- **Session IDs, machine IDs** — Device-identifying information.
- **Prompt prefixes** — Content data.

---

## Data Aggregation Strategy

### Approach: Cron-based pre-aggregation

A scheduled job computes profile data and writes it to `user_period_cache`. This decouples the public page entirely from the raw usage tables.

**Aggregation query** (per user, per period):

```sql
SELECT
  f.name AS feature_key,
  COUNT(*) AS request_count,
  SUM(mu.input_tokens + mu.output_tokens) AS total_tokens,
  MIN(mum.created_at)::date AS first_used,
  MAX(mum.created_at)::date AS last_used,
  COUNT(DISTINCT mum.created_at::date) AS active_days
FROM microdollar_usage mu
JOIN microdollar_usage_metadata mum ON mum.id = mu.id
JOIN feature f ON f.feature_id = mum.feature_id
WHERE mu.kilo_user_id = $1
  AND mum.created_at >= $2
  AND mum.created_at < $3
GROUP BY f.name;
```

**Heatmap query** (last 365 days):

```sql
SELECT
  mum.created_at::date AS date,
  COUNT(*) AS request_count
FROM microdollar_usage mu
JOIN microdollar_usage_metadata mum ON mum.id = mu.id
WHERE mu.kilo_user_id = $1
  AND mum.created_at >= NOW() - INTERVAL '365 days'
GROUP BY mum.created_at::date;
```

### Refresh cadence

| Period type | Refresh frequency | Staleness tolerance |
|---|---|---|
| Current month | Every 6 hours | Up to 6 hours stale |
| Previous months | Once after month ends | Immutable once computed |
| Year summary | Daily during year, once after year ends | Up to 24 hours stale |
| Activity heatmap | Every 6 hours (rolling 365 days) | Up to 6 hours stale |

### Incremental updates

For the current period, only recompute data from the last `computed_at` timestamp forward, then merge with existing cached data. This avoids full-table scans on every refresh cycle.

### Implementation options

1. **Vercel Cron** — Schedule a Next.js API route (`/api/cron/refresh-public-profiles`) that processes users with public profiles enabled. Vercel cron supports up to once-per-hour scheduling on Pro plans.
2. **pg_cron** — Run the aggregation directly in PostgreSQL. Simpler but couples compute to the database.
3. **Cloudflare Worker cron trigger** — If Vercel cron limits are too coarse.

**Recommendation**: Option (1) — Vercel Cron calling a Next.js API route. Keeps logic in TypeScript, testable, and consistent with the existing architecture. Fall back to option (3) if finer scheduling or longer execution windows are needed.

---

## URL Structure

```
/u/{username}                  — Public profile page
/api/public-profile/{user_id}  — API endpoint (internal, feeds SSR)
```

The `/u/` prefix is short, conventional (GitHub uses it), and avoids collision with existing routes (`/profile`, `/usage`, `/share`).

**Username**: The `kilocode_users` table does not currently have a `username` column. Options:

1. **Add a `username` column** to `kilocode_users` — users pick a unique slug. Requires UI for claiming/changing, uniqueness constraint, and reserved-word filtering.
2. **Derive from `shared_url_token`** — Use the `user_period_cache.shared_url_token` as the public URL (e.g., `/u/a8f3k2x9`). No username needed, but URLs are not human-readable.
3. **Use GitHub/LinkedIn handle** — Auto-populate from connected accounts. Not all users have these.

**Recommendation**: Start with option (2) — token-based URLs like `/u/a8f3k2x9` — to ship without requiring a username system. Add vanity usernames as a follow-up.

---

## Privacy Controls

### Visibility settings

Add a `profile_visibility` column to `kilocode_users` (or use a `user_settings` JSONB pattern):

```typescript
type ProfileVisibility = {
  public: boolean                            // Master toggle — is profile accessible?
  show_features: Record<string, boolean>     // Per-feature opt-out
  show_heatmap: boolean
  show_streaks: boolean
  show_totals: boolean
}
```

### Defaults

- **Profile is private by default.** Users must explicitly opt in.
- When enabled, all features and stats are visible by default — users can then hide individual features.
- The profile settings UI lives at `/profile` (existing page), in a new "Public Profile" section.

### GDPR considerations

Per `AGENTS.md` / `gdpr-pii.md` rules: if `profile_visibility` or any new PII column is added, `softDeleteUser` in `src/lib/user.ts` must be updated to clear it, and a corresponding test must be added in `src/lib/user.test.ts`. The `user_period_cache` cleanup already exists in `softDeleteUser`.

---

## Visual Design

### Altair 8800 Aesthetic

The Altair 8800 front panel features:
- A grid of red LEDs indicating binary register states
- Toggle switches below each LED row
- Label plates with white text on dark metal backgrounds
- A utilitarian, industrial-panel feel

### Applying to the profile page

```
┌──────────────────────────────────────────────────────────────────────┐
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  KILO PUBLIC PROFILE                    ● ● ● ○ ○ ● ● ○    │   │
│  │  ─────────────────────                                       │   │
│  │  [Avatar]  Display Name                                      │   │
│  │            @github-handle                                    │   │
│  │            Member since Jan 2024                             │   │
│  │            ○ 142-day streak                                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─ FEATURE PANEL ──────────────────────────────────────────────┐   │
│  │                                                               │   │
│  │  VSCode          ●●●●●●●●○○○○○○○○  ████████░░░░  1,247 req  │   │
│  │  CLI             ●●●●●○○○○○○○○○○○  █████░░░░░░░    892 req  │   │
│  │  JetBrains       ●○○○○○○○○○○○○○○○  █░░░░░░░░░░░     34 req  │   │
│  │  Cloud Agents    ●●●●●●●●●●●○○○○○  ██████████░░  2,103 req  │   │
│  │  App Builder     ●●●○○○○○○○○○○○○○  ███░░░░░░░░░    156 req  │   │
│  │  Kilo Bot        ●●○○○○○○○○○○○○○○  ██░░░░░░░░░░     67 req  │   │
│  │  Code Reviews    ●●●●○○○○○○○○○○○○  ████░░░░░░░░    412 req  │   │
│  │  Kilo Gateway    ●●●●●●●○○○○○○○○○  ███████░░░░░    987 req  │   │
│  │  Agent Manager   ●●○○○○○○○○○○○○○○  ██░░░░░░░░░░     89 req  │   │
│  │  KiloClaw        ●●●○○○○○○○○○○○○○  ███░░░░░░░░░    201 req  │   │
│  │  Security Agent  ●○○○○○○○○○○○○○○○  █░░░░░░░░░░░     12 req  │   │
│  │                                                               │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─ ACTIVITY ───────────────────────────────────────────────────┐   │
│  │  GitHub-style heatmap grid (365 days)                        │   │
│  │  ░░▒▒▓▓██░░░░▒▒▒▓██░░▒▒░░░░▒▓▓▓██░░▒▒▒░░░▒▓█░░▒▒▓▓▓██░░ │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─ STATS ──────────────────────────────────────────────────────┐   │
│  │  Total Requests: 6,200    Active Days: 187    Streak: 142d   │   │
│  └───────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### Visual elements

| Element | Altair 8800 inspiration | Implementation |
|---|---|---|
| Feature LEDs | Front-panel binary status LEDs | Row of 16 circles per feature; filled (red/amber) = relative usage intensity; unfilled = inactive. CSS `radial-gradient` with glow effect. |
| Feature bar | Register indicator strip | Horizontal bar next to LEDs showing proportional usage. Retro monospace font for count labels. |
| Panel border | Metal front panel with label plates | Dark `#1a1a2e` background with subtle metallic border (`box-shadow`). Section headers in a label-plate style (light text, dark recessed background). |
| Activity heatmap | Not directly Altair-inspired | GitHub-style contribution grid, but using amber/red color scale instead of green to match the LED theme. |
| Header LEDs | Status indicator LEDs | Decorative row of small LED dots in the header, animated to blink subtly on page load. |
| Typography | Front panel labeling | Monospace font (`JetBrains Mono` or `IBM Plex Mono`) for data values. Sans-serif for body text. |
| Color palette | Red LEDs on dark panel | Primary: `#ff3333` (LED red), `#ff9933` (LED amber). Background: `#1a1a2e` (dark panel). Text: `#e0e0e0`. Accent: `#00ff66` (active LED green). |

### Responsive design

- Desktop: Full panel layout as shown above.
- Tablet: Feature panel collapses LED row, shows only bar + count.
- Mobile: Stacked cards per feature, heatmap scrolls horizontally.

---

## API Design

### tRPC procedures

Add a new `publicProfile` router:

```typescript
publicProfile.get        // query — Fetch public profile by user_id or share token
publicProfile.toggle     // mutation — Enable/disable public profile
publicProfile.update     // mutation — Update visibility settings
publicProfile.getOwn     // query — Fetch own profile data (authenticated, for preview)
```

### `publicProfile.get` (unauthenticated)

```typescript
input: z.object({
  token: z.string(),    // shared_url_token from user_period_cache
})

output: PublicProfileData | null
// Returns null if profile is not public or token is invalid
```

This procedure is the only unauthenticated endpoint. It reads exclusively from `user_period_cache` — no joins to raw usage tables.

### `publicProfile.toggle` (authenticated)

```typescript
input: z.object({
  enabled: z.boolean(),
})
// When enabled: generates shared_url_token, triggers initial cache computation
// When disabled: clears shared_url_token, sets shared_at = null
```

### `publicProfile.update` (authenticated)

```typescript
input: z.object({
  show_features: z.record(z.string(), z.boolean()).optional(),
  show_heatmap: z.boolean().optional(),
  show_streaks: z.boolean().optional(),
  show_totals: z.boolean().optional(),
})
```

---

## Implementation Plan

### Phase 1: Data layer and API

**Goal:** Cache computation pipeline and API endpoints, no UI.

1. Add `profile_visibility` JSONB column to `kilocode_users` (or a dedicated `user_profile_settings` table).
2. Write the aggregation function that computes `PublicProfileData` from `microdollar_usage` + `microdollar_usage_metadata`.
3. Create the Vercel cron job that refreshes `user_period_cache` rows with `cache_type = 'public_profile'`.
4. Add `publicProfile` tRPC router with `get`, `toggle`, `update`, `getOwn` procedures.
5. Update `softDeleteUser` in `src/lib/user.ts` to clear `profile_visibility` and any new columns. Add test in `src/lib/user.test.ts`.

### Phase 2: Profile settings UI

**Goal:** Let users enable and configure their public profile.

1. Add a "Public Profile" section to the existing `/profile` page.
2. Master toggle to enable/disable.
3. Per-feature visibility toggles.
4. Preview of what the public page looks like.
5. Copy-to-clipboard for the public profile URL.

### Phase 3: Public profile page

**Goal:** The public-facing `/u/{token}` page with Altair 8800 design.

1. Create `/u/[token]/page.tsx` as an ISR (Incremental Static Regeneration) page with `revalidate = 3600` (1 hour).
2. Implement the feature panel with LED indicators and usage bars.
3. Implement the activity heatmap (reuse/adapt existing `StreakCalendar` component from `src/components/profile/StreakCalendar.tsx`).
4. Implement the stats summary section.
5. Responsive layout for mobile/tablet.
6. Open Graph meta tags for social sharing previews.

### Phase 4: Vanity URLs (follow-up)

**Goal:** Human-readable profile URLs.

1. Add `username` column to `kilocode_users` with unique constraint and reserved-word list.
2. Username claim flow in profile settings.
3. Route `/u/{username}` that resolves username → user_id → cached profile data.
4. Redirect token-based URLs to vanity URLs when username is set.

---

## Open Questions

1. **Exact metrics per feature.** The design above shows `request_count`. Should we also display `active_days` per feature, or "last active" timestamps? More metrics = more visual complexity.
2. **Badges / achievements.** Should there be milestone badges (e.g., "1,000 Cloud Agent sessions", "100-day streak")? This adds a gamification layer but also increases scope.
3. **Cache refresh for inactive users.** Should we stop refreshing profiles for users who haven't had activity in N days? This bounds the cron job's work.
4. **Rate limiting on public endpoint.** The `/u/{token}` page should have CDN caching and/or rate limiting to prevent abuse on the unauthenticated endpoint.
5. **SEO and discoverability.** Should public profiles be indexable by search engines (`robots.txt` / `noindex`)? Users may want discoverability, but this has privacy implications.
6. **Data retention for heatmap.** The 365-day rolling window means we recompute from raw data. If `microdollar_usage_metadata` is ever pruned, the heatmap loses history. Consider whether the cached heatmap should be append-only.
7. **Organization profiles.** Should organizations also have public profiles? The `microdollar_usage.organization_id` column exists and could support this, but adds scope.
