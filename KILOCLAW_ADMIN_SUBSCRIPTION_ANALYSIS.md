# KiloClaw Admin Subscription Management — Analysis Report

## Table of Contents

1. [Current KiloClaw Admin UI Capabilities](#1-current-kiloclaw-admin-ui-capabilities)
2. [KiloClaw Billing Implementation](#2-kiloclaw-billing-implementation)
3. [Kilo Pass Admin Subscription Management (Pattern to Follow)](#3-kilo-pass-admin-subscription-management-pattern-to-follow)
4. [Gap Analysis](#4-gap-analysis)
5. [Implementation Plan](#5-implementation-plan)

---

## 1. Current KiloClaw Admin UI Capabilities

### 1.1 Navigation & Pages

KiloClaw admin lives at `/admin/kiloclaw` with a `<Server />` icon in the sidebar (`src/app/admin/components/AppSidebar.tsx:133`). Legacy routes at `/admin/kiloclaw-instances` and `/admin/kiloclaw-versions` redirect here.

| Route | File | Renders |
|-------|------|---------|
| `/admin/kiloclaw` | `src/app/admin/kiloclaw/page.tsx` | `<KiloclawDashboard />` |
| `/admin/kiloclaw/[id]` | `src/app/admin/kiloclaw/[id]/page.tsx` | `<KiloclawInstanceDetail />` |

### 1.2 KiloclawDashboard (Tabbed Interface)

**File:** `src/app/admin/components/KiloclawDashboard.tsx`

Three tabs:

| Tab | Component | Content |
|-----|-----------|---------|
| Instances | `<KiloclawInstancesPage />` | Paginated instance list with stats |
| Versions | `<VersionsTab />` | Image catalog management |
| Pins | `<PinsTab />` | Per-user version pin management |

### 1.3 What Admins Can Do Today

**Instance management:**
- View aggregate stats (total/active/destroyed instances, unique users, avg lifespan)
- View daily created/destroyed chart (30 days)
- Browse/search/filter/sort instances
- View detailed instance info including live Durable Object worker status
- Start/stop Fly machines
- Start/stop/restart gateway processes
- Run OpenClaw doctor diagnostics
- Restore default gateway config
- Destroy instances
- View Fly volume snapshots

**Version management:**
- List/sync/enable/disable container image versions
- Pin/unpin users to specific image versions

**tRPC routers involved:**
- `admin.kiloclawInstances.*` — `src/routers/admin-kiloclaw-instances-router.ts`
- `admin.kiloclawVersions.*` — `src/routers/admin-kiloclaw-versions-router.ts`

### 1.4 What Does NOT Exist

There is **zero subscription management** in the admin UI:

- No KiloClaw subscription card on the user detail page (`src/app/admin/components/UserAdmin/UserAdminDashboard.tsx` — no `UserAdminKiloClaw` component)
- No admin procedures to read or modify `kiloclaw_subscriptions`
- No ability to extend trials, mark as free, change plans, or view billing state
- No link from instance detail to user's subscription record

---

## 2. KiloClaw Billing Implementation

### 2.1 Database Schema

#### `kiloclaw_subscriptions` — `packages/db/src/schema.ts:3449`

Core billing table, one row per user (unique on `user_id`):

| Column | Type | Purpose |
|--------|------|---------|
| `id` | uuid PK | |
| `user_id` | text FK → `kilocode_users.id`, unique | One subscription per user |
| `stripe_subscription_id` | text, unique, nullable | Null during trial |
| `stripe_schedule_id` | text | For plan switches |
| `plan` | `'trial' \| 'commit' \| 'standard'` | Current plan |
| `scheduled_plan` | `'commit' \| 'standard'` | Pending plan switch target |
| `scheduled_by` | `'auto' \| 'user'` | Who scheduled the switch |
| `status` | `'trialing' \| 'active' \| 'past_due' \| 'canceled' \| 'unpaid'` | Current state |
| `cancel_at_period_end` | boolean | Stripe cancel-at-period-end mirror |
| `trial_started_at` | timestamptz | When trial began |
| `trial_ends_at` | timestamptz | When trial expires |
| `current_period_start` | timestamptz | Stripe billing period start |
| `current_period_end` | timestamptz | Stripe billing period end |
| `commit_ends_at` | timestamptz | End of 6-month commit window |
| `past_due_since` | timestamptz | When payment first failed |
| `suspended_at` | timestamptz | When instance was suspended |
| `destruction_deadline` | timestamptz | When instance will be destroyed |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | Auto-updates via `$onUpdateFn` |

#### Enums — `packages/db/src/schema-types.ts:115-149`

```typescript
KiloClawPlan        = { Trial: 'trial', Commit: 'commit', Standard: 'standard' }
KiloClawScheduledPlan = { Commit: 'commit', Standard: 'standard' }
KiloClawScheduledBy = { Auto: 'auto', User: 'user' }
KiloClawSubscriptionStatus = { Trialing: 'trialing', Active: 'active', PastDue: 'past_due', Canceled: 'canceled', Unpaid: 'unpaid' }
```

#### Other KiloClaw tables

| Table | File:Line | Purpose |
|-------|-----------|---------|
| `kiloclaw_instances` | `schema.ts:3306` | Active instances (user_id, sandbox_id, created/destroyed) |
| `kiloclaw_access_codes` | `schema.ts:3331` | One-time browser auth codes |
| `kiloclaw_image_catalog` | `schema.ts:3360` | Container image version registry |
| `kiloclaw_version_pins` | `schema.ts:3407` | Per-user version pins |
| `kiloclaw_earlybird_purchases` | `schema.ts:3432` | One-time earlybird payments |
| `kiloclaw_email_log` | `schema.ts:3498` | Idempotent billing email tracking |

### 2.2 How Trials Work

**Constants:** `src/lib/kiloclaw/constants.ts`
- `KILOCLAW_TRIAL_DURATION_DAYS = 30`
- `KILOCLAW_EARLYBIRD_EXPIRY_DATE = '2026-09-26'`

**Trial creation** (`src/routers/kiloclaw-router.ts:266-329`, `ensureProvisionAccess`):
1. On first provision, if no earlybird and no subscription row exists, a trial is auto-created
2. `plan: 'trial'`, `status: 'trialing'`, `trial_started_at: now`, `trial_ends_at: now + 30 days`
3. Uses `onConflictDoNothing` for concurrent request safety

**Trial lifecycle** (`src/lib/kiloclaw/billing-lifecycle-cron.ts`):

| Sweep | When | Action |
|-------|------|--------|
| 0a: Trial warning | `trial_ends_at` within 5d / 1d | Sends warning emails |
| 1: Trial expiry | `trial_ends_at < now` AND not suspended | Stops instance, sets `status='canceled'`, `suspended_at=now`, `destruction_deadline=now+7d` |
| 2.5: Destruction warning | `destruction_deadline` within 2d | Sends destruction warning email |
| 3: Instance destruction | `destruction_deadline < now` | Destroys instance via worker, marks `destroyed_at` |

**Trial conversion:** When a trialing user subscribes, the Stripe webhook handler (`src/lib/kiloclaw/stripe-handlers.ts:140`) upserts the subscription row, overwriting the trial state with active subscription state.

### 2.3 How Subscriptions Work

**Plans & Pricing** (from UI components):
| Plan | Price | Billing | Notes |
|------|-------|---------|-------|
| Commit | $9/month | Monthly, 6-month commitment | `commit_ends_at` tracks window |
| Standard | $25/month | Monthly, cancel anytime | No commitment |

**Stripe integration:**
- Checkout: `src/routers/kiloclaw-router.ts:1105-1187` — `createSubscriptionCheckout`
- Webhook handlers: `src/lib/kiloclaw/stripe-handlers.ts`:
  - `handleKiloClawSubscriptionCreated` (line 140)
  - `handleKiloClawSubscriptionUpdated` (line 271)
  - `handleKiloClawSubscriptionDeleted` (line 372)
  - `handleKiloClawScheduleEvent` (line 419)

### 2.4 Access Gate

**File:** `src/lib/kiloclaw/access-gate.ts`

`requireKiloClawAccess(userId)` grants access when any of:
1. `KILOCLAW_BILLING_ENFORCEMENT` is `false` (global bypass)
2. `status === 'active'`
3. `status === 'past_due'` AND `suspended_at` is null (grace period)
4. `status === 'trialing'` AND `trial_ends_at > now`
5. Earlybird purchase exists AND `KILOCLAW_EARLYBIRD_EXPIRY_DATE > now`

**Key insight for "free" feature:** There is currently no per-user bypass. The only bypass is the global `KILOCLAW_BILLING_ENFORCEMENT` env var.

### 2.5 User-Facing Billing UI

**Directory:** `src/app/(app)/claw/components/billing/`
- `BillingWrapper.tsx` — root billing container
- `BillingBanner.tsx` — status banners (trial countdown, past_due, etc.)
- `AccessLockedDialog.tsx` — blocks access when expired
- `PlanSelectionDialog.tsx` — commit vs standard plan chooser
- `SubscriptionCard.tsx` — active subscription management
- `WelcomePage.tsx` — initial plan selection for new users

---

## 3. Kilo Pass Admin Subscription Management (Pattern to Follow)

### 3.1 Admin UI Component

**File:** `src/app/admin/components/UserAdmin/UserAdminKiloPass.tsx` (349 lines)

A `'use client'` card component rendered in `UserAdminDashboard.tsx:51`. It:
1. Fetches data via `useQuery(trpc.admin.users.getKiloPassState.queryOptions({ userId }))`
2. Displays subscription info grid (status badge, tier, cadence, streak)
3. Shows current period usage with progress bar
4. Shows bonus threshold info with a "Check bonus" admin action button
5. Shows issuance history grouped by month
6. Provides a "Nuke Pass" destructive action with confirmation dialog requiring a reason

### 3.2 Admin tRPC Procedures

All live in `src/routers/admin-router.ts` under the `users` sub-router:

| Procedure | Type | Lines | Purpose |
|-----------|------|-------|---------|
| `admin.users.getKiloPassState` | query | 350–444 | Full subscription state + issuances + usage + thresholds |
| `admin.users.checkKiloPass` | mutation | 217–244 | Manually trigger bonus threshold check |
| `admin.users.cancelAndRefundKiloPass` | mutation | 496–664 | Cancel Stripe sub, refund, block, zero balance |

### 3.3 Service Layer

- `src/lib/kilo-pass/state.ts` — `getKiloPassStateForUser()`: queries all subscriptions, picks best by priority
- `src/lib/kilo-pass/issuance.ts` — credit issuance logic
- `src/lib/kilo-pass/usage-triggered-bonus.ts` — bonus threshold checking
- `src/lib/kilo-pass/scheduled-change-release.ts` — plan change cleanup

### 3.4 Dashboard Composition

**File:** `src/app/admin/components/UserAdmin/UserAdminDashboard.tsx` (68 lines)

Cards are rendered in a grid layout. Each card component receives minimal props (typically just `userId`). The `<UserAdminKiloPass userId={user.id} />` component sits alongside other cards like `UserAdminNotes`, `UserAdminGdprRemoval`, etc.

### 3.5 Organization-Level Trial/Free Patterns (Additional Reference)

While Kilo Pass has no trial/free concept, **organizations do**:

**Extend trial:** `organizations.free_trial_end_at` column set via:
- UI: `TrialEndDateDialog` (`src/app/admin/components/OrganizationAdmin/TrialEndDateDialog.tsx`) — date picker dialog
- Hook: `useUpdateOrganizationFreeTrialEndAt()` (`src/app/api/organizations/hooks.ts:227`)
- tRPC: `organizations.admin.updateFreeTrialEndAt` (`src/routers/organizations/organization-admin-router.ts:180`)
- DB: `UPDATE organizations SET free_trial_end_at = $date WHERE id = $orgId`

**Mark as free:** `organizations.require_seats` column set to `false` via:
- UI: `SeatsRequirementDialog` (`src/app/admin/components/OrganizationAdmin/SeatsRequirementDialog.tsx`)
- tRPC: `organizations.updateSeatsRequired` (`src/routers/organizations/organization-router.ts:266`)
- Effect: Bypasses all trial enforcement in `trial-middleware.ts` and `isOrganizationHardLocked()`

---

## 4. Gap Analysis

### 4.1 Admin UI Components Needed

| What | Status | Action Required |
|------|--------|-----------------|
| `UserAdminKiloClaw` card component | **Missing** | Create new component in `src/app/admin/components/UserAdmin/` |
| Add to `UserAdminDashboard.tsx` | **Missing** | Import and render `<UserAdminKiloClaw userId={user.id} />` |
| Subscription info display | **Missing** | Show plan, status, trial dates, billing period, suspension state |
| "Extend Trial" action | **Missing** | Date picker dialog (follow `TrialEndDateDialog` pattern) |
| "Mark as Free" action | **Missing** | Toggle button with confirmation (follow `SeatsRequirementDialog` pattern) |

### 4.2 Admin tRPC Procedures Needed

| Procedure | Status | Purpose |
|-----------|--------|---------|
| `admin.users.getKiloClawSubscriptionState` | **Missing** | Query subscription data for user detail page |
| `admin.users.extendKiloClawTrial` | **Missing** | Update `trial_ends_at` to a new date |
| `admin.users.setKiloClawFree` | **Missing** | Mark subscription as "free" (new plan type or dedicated column) |

### 4.3 Database Changes Needed

#### Option A: Add `'free'` to `KiloClawPlan` enum (Recommended)

Add `Free: 'free'` to `KiloClawPlan` in `packages/db/src/schema-types.ts`. This requires:
1. A new migration adding `'free'` to the `kiloclaw_subscriptions_plan_check` constraint
2. Update the access gate (`src/lib/kiloclaw/access-gate.ts`) to grant access when `plan === 'free'`
3. Update the billing lifecycle cron (`src/lib/kiloclaw/billing-lifecycle-cron.ts`) to skip `free` plan users in all sweeps
4. Update the user-facing UI to not show billing prompts for free users

#### Option B: Add a `is_free` boolean column

Add `is_free: boolean().notNull().default(false)` to `kiloclaw_subscriptions`. Simpler but less explicit.

#### Option C: Use the existing `KILOCLAW_BILLING_ENFORCEMENT` pattern per-user

Not feasible — this is a global env var, not per-user.

**Recommendation:** Option A (`'free'` plan) is the cleanest approach. It parallels how `'trial'` works (a plan without a Stripe subscription), integrates naturally with the existing schema, and makes queries/filtering straightforward.

### 4.4 Access Gate Changes

**File:** `src/lib/kiloclaw/access-gate.ts:30-36`

Current logic checks `status` but not `plan`. For the "free" feature:

```
if (sub.status === 'active') return;  // already handles it IF we set status to 'active' for free plans
```

If `plan === 'free'` gets `status === 'active'` (no Stripe subscription needed), the existing access gate already grants access. No change required to the gate itself — just ensure the admin mutation sets both `plan: 'free'` and `status: 'active'`.

### 4.5 Billing Lifecycle Cron Changes

**File:** `src/lib/kiloclaw/billing-lifecycle-cron.ts`

The cron must skip free-plan users. The cron sweeps already filter by specific statuses:
- Sweep 0a filters `status = 'trialing'` — free users won't match
- Sweep 1 filters `status = 'trialing'` — free users won't match
- Sweep 2 filters `status = 'canceled'` — free users won't match
- Sweep 4 filters `status = 'past_due'` — free users won't match

If `plan: 'free'` always has `status: 'active'`, no cron changes are needed since the cron doesn't touch active subscriptions. **However**, as a safety measure, adding `plan != 'free'` conditions would be prudent.

### 4.6 User-Facing UI Changes

**File:** `src/app/(app)/claw/components/billing/billing-types.ts`

The billing status derivation function would need to handle `plan === 'free'` — showing something like "Free plan (admin-granted)" instead of billing prompts.

---

## 5. Implementation Plan

### Phase 1: Backend — Admin tRPC Procedures

#### 1a. `admin.users.getKiloClawSubscriptionState` (Query)

**File to modify:** `src/routers/admin-router.ts` (add to the `users` sub-router)

**Logic:**
```
1. Query kiloclaw_subscriptions WHERE user_id = input.userId
2. Query kiloclaw_earlybird_purchases WHERE user_id = input.userId  
3. Query kiloclaw_instances WHERE user_id = input.userId (active + recent destroyed)
4. Return: { subscription, earlybirdPurchase, instances }
```

**Data returned:**
- Subscription: all columns from `kiloclaw_subscriptions` (plan, status, trial dates, billing period, suspension state, Stripe IDs)
- Earlybird: purchase date and amount (if any)
- Instance summary: active instance count, most recent instance info

#### 1b. `admin.users.extendKiloClawTrial` (Mutation)

**File to modify:** `src/routers/admin-router.ts`

**Input:** `{ userId: string, newTrialEndDate: string (ISO datetime) }`

**Logic:**
```
1. Fetch kiloclaw_subscriptions WHERE user_id = userId
2. Validate:
   - Subscription exists
   - plan === 'trial' AND status === 'trialing' (or status === 'canceled' with plan === 'trial' for re-extending expired trials)
3. UPDATE kiloclaw_subscriptions SET 
     trial_ends_at = newTrialEndDate,
     status = 'trialing',           -- restore if was canceled due to expiry
     suspended_at = NULL,            -- clear suspension
     destruction_deadline = NULL     -- clear destruction deadline
   WHERE user_id = userId
4. If instance was stopped, optionally resume it (call KiloClawInternalClient.start)
5. Delete relevant email log entries (claw_suspended_trial, claw_destruction_warning, claw_instance_destroyed) to allow re-sending if trial expires again
6. Return { success, previousTrialEndDate, newTrialEndDate }
```

**Edge cases to handle:**
- User has no subscription row → create one with trial plan (or return error)
- User has an active paid subscription → reject (trial extension doesn't apply)
- User's instance was destroyed → cannot auto-resume (destroyed instances can't be restarted)

#### 1c. `admin.users.setKiloClawFree` (Mutation)

**File to modify:** `src/routers/admin-router.ts`

**Input:** `{ userId: string, isFree: boolean, reason: string }`

**Logic for `isFree: true`:**
```
1. Fetch kiloclaw_subscriptions WHERE user_id = userId
2. If exists:
   - UPDATE kiloclaw_subscriptions SET
       plan = 'free',
       status = 'active',
       suspended_at = NULL,
       destruction_deadline = NULL,
       cancel_at_period_end = false
     WHERE user_id = userId
3. If not exists:
   - INSERT kiloclaw_subscriptions (user_id, plan, status)
     VALUES (userId, 'free', 'active')
4. If instance was stopped/suspended, resume it
5. Return { success, previousPlan, previousStatus }
```

**Logic for `isFree: false`:**
```
1. Fetch kiloclaw_subscriptions WHERE user_id = userId AND plan = 'free'
2. Decide what to revert to:
   - If user had a trial that hasn't been fully used, revert to trial
   - Otherwise, set status = 'canceled' (user must subscribe)
3. UPDATE accordingly
4. Return { success, newPlan, newStatus }
```

### Phase 2: Database Migration

#### 2a. Add `'free'` to `KiloClawPlan`

**File to modify:** `packages/db/src/schema-types.ts:117-121`

```diff
 export const KiloClawPlan = {
   Trial: 'trial',
   Commit: 'commit',
   Standard: 'standard',
+  Free: 'free',
 } as const;
```

#### 2b. Create migration

**New file:** `packages/db/src/migrations/XXXX_add_kiloclaw_free_plan.sql`

```sql
-- Drop and re-create the plan check constraint to include 'free'
ALTER TABLE kiloclaw_subscriptions DROP CONSTRAINT IF EXISTS kiloclaw_subscriptions_plan_check;
ALTER TABLE kiloclaw_subscriptions ADD CONSTRAINT kiloclaw_subscriptions_plan_check 
  CHECK (plan IN ('trial', 'commit', 'standard', 'free'));
```

### Phase 3: Access Gate & Cron Safety

#### 3a. Access Gate (Likely no changes needed)

**File:** `src/lib/kiloclaw/access-gate.ts`

If `plan: 'free'` has `status: 'active'`, the existing `if (sub.status === 'active') return;` at line 31 already grants access. No changes required.

#### 3b. Billing Lifecycle Cron (Safety guard)

**File:** `src/lib/kiloclaw/billing-lifecycle-cron.ts`

Add `plan != 'free'` to sweep queries as a safety measure, even though current status-based filters should exclude free users. Key locations:
- Sweep 0a (trial warning): already filters `status = 'trialing'` — safe
- Sweep 1 (trial expiry): already filters `status = 'trialing'` — safe, but add `plan != 'free'` guard
- Sweep 2 (subscription expiry): filters `status = 'canceled'` — safe
- Sweep 4 (past-due cleanup): filters `status = 'past_due'` — safe

### Phase 4: Admin UI Component

#### 4a. Create `UserAdminKiloClaw` Component

**New file:** `src/app/admin/components/UserAdmin/UserAdminKiloClaw.tsx`

Follow the `UserAdminKiloPass.tsx` pattern (349 lines). Structure:

```
'use client'

Props: { userId: string }

Data fetching:
  useQuery(trpc.admin.users.getKiloClawSubscriptionState.queryOptions({ userId }))

Rendered sections:
1. Subscription Info Grid
   - Plan (badge: trial/commit/standard/free)
   - Status (colored badge: green=active/trialing, red=canceled, yellow=past_due)
   - Trial dates (if applicable): started_at, ends_at, days remaining
   - Billing period: current_period_start → current_period_end
   - Commit window: commit_ends_at (if commit plan)
   - Stripe subscription ID (linked to Stripe dashboard)
   - cancel_at_period_end indicator
   - suspended_at / destruction_deadline warnings

2. Earlybird Info (if applicable)
   - Purchase date, amount

3. Instance Summary
   - Active instance count, link to /admin/kiloclaw/{id}

4. Admin Actions
   a. "Extend Trial" button (only shown when plan === 'trial')
      → Opens date picker dialog
      → Calls admin.users.extendKiloClawTrial
   
   b. "Mark as Free" / "Remove Free" toggle button
      → Opens confirmation dialog with reason textarea
      → Calls admin.users.setKiloClawFree
```

#### 4b. Add to UserAdminDashboard

**File to modify:** `src/app/admin/components/UserAdmin/UserAdminDashboard.tsx`

```diff
+ import UserAdminKiloClaw from './UserAdminKiloClaw';

  // In the grid layout, after UserAdminKiloPass:
  <UserAdminKiloPass userId={user.id} />
+ <UserAdminKiloClaw userId={user.id} />
```

#### 4c. Trial Extension Dialog

**New component** (inline in `UserAdminKiloClaw.tsx` or separate file):

Follow the `TrialEndDateDialog` pattern from `src/app/admin/components/OrganizationAdmin/TrialEndDateDialog.tsx`:
- Date picker input
- Save / Clear / Cancel actions
- Calls `admin.users.extendKiloClawTrial`
- Invalidates query on success
- Shows toast with old and new dates

#### 4d. Mark as Free Dialog

Follow the `SeatsRequirementDialog` pattern:
- Confirmation text explaining consequences
- Required reason textarea (following the "Nuke Pass" pattern)
- Toggle between "Mark as Free" and "Remove Free Status"
- Calls `admin.users.setKiloClawFree`

### Phase 5: User-Facing UI (Optional, Low Priority)

#### 5a. Billing Status for Free Users

**File:** `src/app/(app)/claw/components/billing/billing-types.ts`

Add handling for `plan === 'free'`:
- Show "Free plan" label instead of billing prompts
- Hide upgrade/cancel buttons
- Optionally show "Granted by admin" note

### Implementation Order (Suggested)

| Step | Task | Estimated Effort | Dependencies |
|------|------|-----------------|--------------|
| 1 | Add `'free'` to `KiloClawPlan` enum + migration | Small | None |
| 2 | Add `getKiloClawSubscriptionState` query to admin router | Medium | None |
| 3 | Add `extendKiloClawTrial` mutation to admin router | Medium | None |
| 4 | Add `setKiloClawFree` mutation to admin router | Medium | Step 1 |
| 5 | Add cron safety guards | Small | Step 1 |
| 6 | Create `UserAdminKiloClaw` component | Large | Steps 2-4 |
| 7 | Add component to `UserAdminDashboard` | Small | Step 6 |
| 8 | Update user-facing billing UI for free plan | Small | Step 1 |

### Files to Create

| File | Purpose |
|------|---------|
| `src/app/admin/components/UserAdmin/UserAdminKiloClaw.tsx` | Admin card component for KiloClaw subscription management |
| `packages/db/src/migrations/XXXX_add_kiloclaw_free_plan.sql` | Migration to add 'free' to plan constraint |

### Files to Modify

| File | Change |
|------|--------|
| `packages/db/src/schema-types.ts` | Add `Free: 'free'` to `KiloClawPlan` |
| `src/routers/admin-router.ts` | Add 3 new procedures to `users` sub-router |
| `src/app/admin/components/UserAdmin/UserAdminDashboard.tsx` | Import and render `UserAdminKiloClaw` |
| `src/lib/kiloclaw/billing-lifecycle-cron.ts` | Add `plan != 'free'` safety guards |
| `src/app/(app)/claw/components/billing/billing-types.ts` | Handle `plan === 'free'` in billing status |

### Key Design Decisions

1. **"Free" as a plan type, not a boolean:** Using `plan: 'free'` with `status: 'active'` is cleaner than a separate `is_free` column. It naturally integrates with the existing access gate (which checks status, not plan) and the billing lifecycle cron (which filters by status).

2. **Trial extension clears suspension state:** When an admin extends a trial, `suspended_at` and `destruction_deadline` should be cleared, and the status should be restored to `'trialing'`. This handles the case where a trial expired and the user was suspended — the extension effectively un-suspends them.

3. **Email log cleanup on trial extension:** Relevant email log entries (`claw_suspended_trial`, `claw_destruction_warning`, `claw_instance_destroyed`) should be deleted so these emails can be re-sent if the extended trial subsequently expires.

4. **Instance resumption:** When extending a trial or marking as free for a user whose instance was stopped (but not destroyed), the admin mutation should optionally resume the instance via `KiloClawInternalClient`. If the instance was destroyed, the user will need to re-provision.

5. **Reason tracking:** The "mark as free" action should require a reason (following the "Nuke Pass" pattern). Consider storing this in an admin notes system or adding a `free_reason` column to the subscription table.

6. **Reversibility:** Both actions should be reversible. Trial extension can be "un-extended" by setting a past date (though this is unusual). Free status can be toggled off, reverting to canceled status.
