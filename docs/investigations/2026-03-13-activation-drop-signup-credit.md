# Investigation: New-User Activation Drop After Stytch Validation

**Date:** 2026-03-13
**Investigating:** Drop in activation for new users who passed Stytch validation

---

## Finding: Free $5 Signup Credit Was Removed

The **$5 automatic welcome credit** granted to new users who pass Turnstile + Stytch
validation during signup was **merged to `main` on March 11, 2026 at 14:02:54 UTC**
via PR #940. This is the most likely cause of the observed activation drop.

### Timeline of Changes

#### 1. Original branch attempt (never merged) -- March 9, 2026

| Field       | Value |
|-------------|-------|
| Commit      | `831f1b2fbda5c8f95900603c6dbd04fc511f92dc` |
| Author date | 2026-03-09 08:48:15 UTC |
| Author      | kiloconnect[bot] (initiated by Mark IJbema) |
| Branch      | `remove-free-5-signup-credit` |
| PR          | #928 -- **closed without merging** on 2026-03-09 09:16:19 UTC |

> **Important:** Commit `831f1b2f` was **never merged to `main`**. It exists only on
> the stale `remove-free-5-signup-credit` branch. PR #928, which contained this commit,
> was closed without merging. The credit was **not** disabled on `main` on March 9.

**What this commit proposed (same changes later re-authored in PR #940):**
- `src/lib/stytch.ts`: `handleSignupPromotion()` converted to a no-op -- it previously
  called `grantCreditForCategory(user, { credit_category: 'automatic-welcome-credits' })`
  to grant $5 when a user passed both Turnstile and Stytch validation.
- `src/lib/promoCreditCategories.ts`: `automatic-welcome-credits` category `amount_usd`
  changed from `5` to `0`.
- `src/lib/notifications.ts`: The "Welcome to Kilo Code! We added $5 to your balance"
  first-day notification was disabled (function returns empty array).
- `src/lib/stytch.test.ts`: Test updated to reflect no credit is granted.

#### 2. Re-authored PR #940 -- March 9--11, 2026

A new branch `mark/remove-free-5-signup-credit` was created with re-authored commits:

| # | Commit | Date (UTC) | Author | Message |
|---|--------|------------|--------|---------|
| 1 | `ed7c493f` | 2026-03-09 12:25:27 | Mark IJbema | `feat(credits): disable free $5 signup credit for new users` |
| 2 | `bd0919fc` | 2026-03-09 12:37:27 | Mark IJbema | `style: run pnpm format` |
| 3 | `20dd9f8a` | 2026-03-09 12:55:50 | Mark IJbema | `refactor: remove dead signup credit code per review` |

PR #940 was created on 2026-03-09 12:26:40 UTC. These commits include the same
functional changes as the original `831f1b2f` plus a dead-code cleanup:

- `src/lib/stytch.ts`: `handleSignupPromotion()` function deleted entirely.
- `src/app/account-verification/page.tsx`: Removed the call to `handleSignupPromotion()`.
- `src/lib/promoCreditCategories.ts`: `automatic-welcome-credits` entry removed entirely.
- `src/lib/promoCreditCategoriesOld.ts`: Entry moved here with `obsolete: true` for
  historical reference.
- `src/lib/notifications.ts`: `generateFirstDayWelcomeNotification` function removed from
  the notification generators list and deleted.
- `src/lib/stytch.test.ts`: All signup credit tests removed.

#### 3. Merged to main via PR #940 -- March 11, 2026

| Field       | Value |
|-------------|-------|
| Merge commit | `47d0cc2d2b8527dec33cdb42e85adc4192ff8310` |
| Merged at   | **2026-03-11 14:02:54 UTC** |
| Merged by   | Mark IJbema |
| PR          | #940 |
| Message     | `feat(credits): remove free $5 credit for new users (#940)` |

This merge commit landed the three re-authored commits (`ed7c493f`, `bd0919fc`,
`20dd9f8a`) onto `main`. The original commit `831f1b2f` from the closed PR #928 was
**not** included -- it remains only on the stale `remove-free-5-signup-credit` branch.

---

## March 10 Deployment Window (1:00--4:00 PM UTC): 36 Commits

None of the 36 commits in this window directly modified the signup credit grant
mechanism (that change was still on a branch at the time). However, two commits in this
window affected new-user-adjacent incentives:

### Early Bird Offer Removed

| Field       | Value |
|-------------|-------|
| Commit      | `5d81d4b7a6c3c381c30defad47d138d15252ac0b` |
| Date        | 2026-03-10 13:37:13 UTC |
| Author      | kiloconnect[bot] |
| Message     | `feat(claw): remove early bird purchase offer and mark earlybird as sold out` |

Removed the KiloClaw early bird 50%-off purchase flow and replaced with a "Sold Out"
notice. This affects the `/claw/earlybird` page and the dashboard banner. Not directly
related to signup credits, but removes a new-user-visible incentive.

### Early Bird Banner Restored for Existing Purchasers

| Field       | Value |
|-------------|-------|
| Commit      | `904404a60bace4c78e0df3eeb8b2f7708b9ba3f7` |
| Date        | 2026-03-10 13:57:46 UTC |
| Author      | kiloconnect[bot] |
| Message     | `feat(claw): restore earlybird banner for users who already purchased` |

Re-added the earlybird banner but only for users who already purchased. Non-purchasers
no longer see any earlybird banner or offer link.

---

## Other Relevant Changes in the Broader Git History

### Free Trial Duration Reduced (30 days to 14 days) -- March 3, 2026

| Field       | Value |
|-------------|-------|
| Commit      | `56dcf53831033f8fb21f29a0552aff90b8dfcda1` |
| Date        | 2026-03-03 15:21:41 -0500 |
| Author      | Alex Gold |
| Message     | `Change free trial duration from 30 days to 14 days (#667)` |

Reduced `TRIAL_DURATION_DAYS` from 30 to 14 in `src/lib/constants.ts` and updated all
user-facing copy. This compounds the activation impact for new users.

### Blocked Email TLDs for Signups -- March 2, 2026

| Field       | Value |
|-------------|-------|
| Commit      | `0d6029484c413d3266bdff67fa17d53bb8777123` |
| Date        | 2026-03-02 21:54:38 UTC |
| Author      | kiloconnect[bot] |
| Message     | `Block signups from .shop, .top, and .xyz email TLDs` |

Blocks new signups from specific email TLDs. Reduces the pool of new users who can
sign up, but does not affect activation of those who do successfully sign up.

---

## Conclusion

The primary cause of the activation drop for new users who passed Stytch validation is
almost certainly the **removal of the $5 automatic welcome credit**. This was:

1. **Authored on March 9** (commit `831f1b2f` on branch, PR #928 closed without merging)
2. **Merged to `main` on March 11 at 14:02:54 UTC** (PR #940, merge commit `47d0cc2d`)

The credit was **not** disabled on `main` on March 9. The original PR #928 was closed
and a new PR #940 was created with re-authored commits, which was merged two days later.

Before this change, every new user who passed both Turnstile and Stytch validation
received a $5 credit automatically via `grantCreditForCategory()` with category
`automatic-welcome-credits`. This credit gave new users an immediate, tangible reason
to try the product. Without it, new users who pass validation have zero balance and no
immediate incentive to engage.

The **first-day welcome notification** ("We added $5 to your balance to get started!")
was also removed, eliminating the onboarding nudge that directed new users to try the
product.

Contributing factors include the **trial duration reduction from 30 to 14 days**
(March 3) and the **early bird offer removal** (March 10).
