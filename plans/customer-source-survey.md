# Customer Source Survey — Implementation Plan

## Goal

Add a "Where did you hear about Kilo Code?" free-text survey page that appears once per user after account verification and before `/get-started`. Users can submit or skip.

## Current Flow (new user)

```
Sign In → /users/after-sign-in →
  has_validation_stytch === null →
    /account-verification (Stytch) →
      stytchStatus !== null → redirect('/get-started')
```

## Target Flow (new user)

```
Sign In → /users/after-sign-in →
  has_validation_stytch === null →
    /account-verification (Stytch) →
      stytchStatus !== null → redirect('/customer-source-survey') → /get-started
```

Existing users who already have `customer_source` set: unchanged.
Existing users with `customer_source === null`: optionally intercept in `after-sign-in` (lower priority).

---

## Task 1: Add `customer_source` column to schema

**File:** `packages/db/src/schema.ts`

Add to the `kilocode_users` table definition (after `openrouter_upstream_safety_identifier` on line 194):

```ts
customer_source: text(),
```

This is nullable by default (no `.notNull()`), so null = not answered, non-null = answered.

The `User` type on line 206 (`typeof kilocode_users.$inferSelect`) will automatically include this field.

## Task 2: Generate database migration

Run from the repo root:

```bash
cd packages/db && pnpm drizzle-kit generate
```

This will create a new migration file `packages/db/src/migrations/0049_*.sql` with:
```sql
ALTER TABLE "kilocode_users" ADD COLUMN "customer_source" text;
```

Verify the generated SQL is correct — it should be a single `ALTER TABLE ADD COLUMN`.

## Task 3: Add `submitCustomerSource` tRPC mutation

**File:** `src/routers/user-router.ts`

Add after the `markWelcomeFormCompleted` mutation (line 289). Follow the exact same pattern:

```ts
submitCustomerSource: baseProcedure
  .input(z.object({ source: z.string().min(1).max(1000) }))
  .mutation(async ({ ctx, input }) => {
    await db
      .update(kilocode_users)
      .set({ customer_source: input.source })
      .where(eq(kilocode_users.id, ctx.user.id));
    return successResult();
  }),
```

All imports (`z`, `db`, `kilocode_users`, `eq`, `successResult`, `baseProcedure`) are already available in this file.

## Task 4: Create the survey page (server component)

**File:** `src/app/customer-source-survey/page.tsx` (NEW)

```tsx
import { redirect } from 'next/navigation';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { KiloCardLayout } from '@/components/KiloCardLayout';
import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';
import { CustomerSourceSurvey } from '@/components/CustomerSourceSurvey';

export default async function CustomerSourceSurveyPage({ searchParams }: AppPageProps) {
  const user = await getUserFromAuthOrRedirect('/users/sign_in');
  const params = await searchParams;

  // Determine where to go after survey
  const callbackParam = params.callbackPath;
  const redirectPath =
    callbackParam && typeof callbackParam === 'string' && isValidCallbackPath(callbackParam)
      ? callbackParam
      : '/get-started';

  // If already answered, skip past
  if (user.customer_source !== null) {
    redirect(redirectPath);
  }

  return (
    <KiloCardLayout title="Where did you hear about Kilo Code?" className="max-w-2xl">
      <CustomerSourceSurvey redirectPath={redirectPath} />
    </KiloCardLayout>
  );
}
```

**Notes:**
- `getUserFromAuthOrRedirect` is the same helper used by `account-verification/page.tsx` — it returns the user or redirects to sign-in.
- `AppPageProps` is the global type for Next.js page props (already declared in this project).
- `isValidCallbackPath` already matches `/customer-source-survey` via regex `^\/(users\/)?[-a-zA-Z0-9]+\/?(\?.*)?(#.*)?$` — no whitelist change needed.

## Task 5: Create the survey form (client component)

**File:** `src/components/CustomerSourceSurvey.tsx` (NEW)

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import Link from 'next/link';

type CustomerSourceSurveyProps = {
  redirectPath: string;
};

export function CustomerSourceSurvey({ redirectPath }: CustomerSourceSurveyProps) {
  const [source, setSource] = useState('');
  const router = useRouter();
  const trpc = useTRPC();

  const { mutate: submitSource, isPending } = useMutation(
    trpc.user.submitCustomerSource.mutationOptions({
      onSuccess: () => {
        router.push(redirectPath);
      },
    })
  );

  return (
    <div className="space-y-4 px-6 pb-6">
      <Textarea
        placeholder="Example: A YouTube video from Theo"
        value={source}
        onChange={e => setSource(e.target.value)}
        rows={3}
        maxLength={1000}
      />
      <div className="flex items-center justify-between">
        <Link href={redirectPath} className="text-muted-foreground text-sm hover:underline">
          Skip
        </Link>
        <Button
          onClick={() => submitSource({ source })}
          disabled={isPending || source.trim().length === 0}
        >
          {isPending ? 'Submitting...' : 'Submit'}
        </Button>
      </div>
    </div>
  );
}
```

**Notes:**
- Uses `useTRPC()` + `useMutation()` — the same pattern as `EditProfileDialog.tsx` and `AutoTopUpToggle.tsx`.
- `Button` and `Textarea` are existing shadcn/ui components in `src/components/ui/`.
- Skip link navigates without saving (customer_source stays null).

## Task 6: Update account-verification redirect

**File:** `src/app/account-verification/page.tsx`

Change lines 18–24 from:

```ts
  if (stytchStatus !== null) {
    // Check for callbackPath to redirect to after verification
    const callbackPath = params.callbackPath;
    if (callbackPath && typeof callbackPath === 'string' && isValidCallbackPath(callbackPath)) {
      redirect(callbackPath);
    }
    redirect('/get-started');
  }
```

To:

```ts
  if (stytchStatus !== null) {
    // Route through customer source survey before final destination
    const callbackPath = params.callbackPath;
    if (callbackPath && typeof callbackPath === 'string' && isValidCallbackPath(callbackPath)) {
      redirect(`/customer-source-survey?callbackPath=${encodeURIComponent(callbackPath)}`);
    }
    redirect('/customer-source-survey');
  }
```

Both branches now route through the survey. The survey page itself handles the final redirect to `callbackPath` or `/get-started`.

## Task 7 (lower priority): Intercept existing users in after-sign-in

**File:** `src/app/users/after-sign-in/route.tsx`

After the `has_validation_stytch === null` block (line 36), add a check for existing users who haven't taken the survey:

```ts
    if (user.has_validation_stytch === null) {
      // ... existing stytch logic (unchanged)
    } else if (user.customer_source === null) {
      responsePath = `/customer-source-survey?callbackPath=${encodeURIComponent(responsePath)}`;
    }
```

This ensures existing users see the survey once on their next sign-in. The `user` object from `getUserFromAuth` already includes all `kilocode_users` columns via drizzle's `$inferSelect`, so `customer_source` will be available after the schema change.

---

## Files Summary

| File | Action | Task |
|------|--------|------|
| `packages/db/src/schema.ts` | Add `customer_source: text()` column | 1 |
| `packages/db/src/migrations/0049_*.sql` | Auto-generated by drizzle-kit | 2 |
| `src/routers/user-router.ts` | Add `submitCustomerSource` mutation after line 289 | 3 |
| `src/app/customer-source-survey/page.tsx` | **New** — server component for survey page | 4 |
| `src/components/CustomerSourceSurvey.tsx` | **New** — client component for survey form | 5 |
| `src/app/account-verification/page.tsx` | Change redirect targets on lines 22/24 | 6 |
| `src/app/users/after-sign-in/route.tsx` | Add `customer_source === null` check after line 36 | 7 |

## NOT Modified

- `src/lib/getSignInCallbackUrl.ts` — The existing regex `^\/(users\/)?[-a-zA-Z0-9]+\/?` already matches `/customer-source-survey`. No whitelist change needed.

## Verification

1. New account → Stytch verification → should land on `/customer-source-survey`
2. Submit response → saved to DB, redirect to `/get-started`
3. Click "Skip" → redirect to `/get-started`, `customer_source` stays null
4. Revisit `/customer-source-survey` when already answered → redirects past it
5. `SELECT customer_source FROM kilocode_users WHERE id = '...'` shows saved value
6. Existing user with `customer_source = null` → sees survey on next sign-in (Task 7)
