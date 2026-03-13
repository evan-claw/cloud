# Commit Audit: 2026-03-10 13:00–16:00 UTC

**Purpose:** Investigate commits deployed between 13:00–16:00 UTC on March 10, 2026, to identify potential causes of the user activation drop observed between 16:00–19:00 UTC the same day.

**Total commits on `main` in window:** 36

---

## High-Risk Commits (User-Facing / Infrastructure)

These commits modified user-facing code paths, AI gateway routing, or cloud agent infrastructure and are the most likely candidates for impacting user activation.

### 1. `d8ab39a8` — Increase Vercel AI Gateway traffic to 20% (#981)

| Field | Value |
|-------|-------|
| **Author** | Christiaan Arnoldus \<christiaan@kilocode.ai\> |
| **Timestamp** | 2026-03-10T15:09:45+01:00 (14:09 UTC) |
| **Files** | `src/lib/providers/vercel/index.ts` |

**What changed:** Merged `68d2f143` which changed the AI gateway routing logic. The Vercel routing percentage was raised from a previous value to 20% as the default. Additionally, a new branch was added: when the _Vercel_ error rate is high (but OpenRouter is fine), traffic to Vercel drops to 10%. Previously this scenario was not handled — a high Vercel error rate would still route 90% of traffic to Vercel if OpenRouter was also erroring.

**Risk assessment:** **HIGH.** This directly changes how LLM requests are routed across providers. If the Vercel gateway had elevated errors or latency during 16:00–19:00 UTC, 20% of user requests would have been affected. The new fallback logic (Vercel error rate high → drop to 10%) may also have edge cases around threshold flapping.

---

### 2. `62c44057` — feat(kilo): add retry delay and enhanced startup diagnostics

| Field | Value |
|-------|-------|
| **Author** | kiloconnect\[bot\] |
| **Timestamp** | 2026-03-10T14:30:49+00:00 |
| **Files** | `cloud-agent-next/src/kilo/wrapper-client.ts` |

**What changed:** Added a 1.5-second `WRAPPER_RETRY_DELAY_MS` sleep between wrapper startup retry attempts. Also added wrapper log file capture via a new `WRAPPER_LOG_PATH` env var passed to the wrapper process.

**Risk assessment:** **HIGH.** The 1.5s retry delay directly increases the time-to-ready for cloud agent sessions when the first startup attempt fails. If transient failures were common during 16:00–19:00 UTC, users would experience noticeably slower session starts (1.5s+ added latency per retry). The new env var `WRAPPER_LOG_PATH` being passed to the wrapper could also cause issues if the wrapper process doesn't expect it.

---

### 3. `33e37308` — fix(cloud-agent-next): add pre-flight check before wrapper startup

| Field | Value |
|-------|-------|
| **Author** | Evgeny Shurakov \<eshurakov@users.noreply.github.com\> |
| **Timestamp** | 2026-03-10T16:44:18+01:00 (15:44 UTC) |
| **Files** | `cloud-agent-next/src/kilo/wrapper-client.ts`, `cloud-agent-next/src/kilo/wrapper-client.test.ts` |

**What changed:** Added pre-flight checks (`bun --version` and `test -f <wrapperPath>`) before attempting the full wrapper startup loop. Failures from the pre-flight exec are non-blocking (caught and logged), but definitive failures (SIGILL, missing binary) throw `WrapperNotReadyError` immediately.

**Risk assessment:** **MEDIUM-HIGH.** The pre-flight adds two `exec` calls (with 5s timeouts each) to every cloud agent session startup. In the success path this adds latency. In sandbox environments where `exec` is slow or flaky, this could cause previously-working sessions to fail fast with `WrapperNotReadyError` instead of retrying. Combined with commit `62c44057` (retry delay), the cumulative startup overhead is significant.

---

### 4. `0ca144fb` — feat(github): Pass GitHub App type to check run updates

| Field | Value |
|-------|-------|
| **Author** | sentry\[bot\] |
| **Timestamp** | 2026-03-10T13:28:00+00:00 |
| **Files** | `src/app/api/internal/code-review-status/[reviewId]/route.ts`, `src/routers/code-reviews/code-reviews-router.ts` |

**What changed:** Added `integration.github_app_type ?? 'standard'` as a new argument to `updatePRGateCheck` and the check run cancellation call. This passes the GitHub App type through to check run update calls.

**Risk assessment:** **MEDIUM.** If the downstream function's signature wasn't updated to accept this parameter, or if `github_app_type` is undefined for some integrations and `'standard'` is incorrect, this could cause check run updates to fail silently or throw, breaking the code review status reporting flow for some users.

---

### 5. `d47f4f6e` — fix(code-reviews): fix billing query timeout preventing usage footer on v2 reviews (#979)

| Field | Value |
|-------|-------|
| **Author** | Marian Alexandru Alecu |
| **Timestamp** | 2026-03-10T16:13:06+02:00 (14:13 UTC) |
| **Files** | `src/app/api/internal/code-review-status/[reviewId]/route.ts`, `src/lib/code-reviews/db/code-reviews.ts` |

**What changed:** Added a `created_at` lower bound to the billing fallback query to avoid a sequential scan on a ~469M row table. Also removed the v1 poll loop for v2 reviews and deleted a migration file (session_id index).

**Risk assessment:** **MEDIUM.** This is a bug fix that should improve performance, but it changes the code review status route behavior. The removal of the v1 poll loop for v2 reviews could have edge effects if any reviews were in a transitional state.

---

### 6. `6a860192` — feat(sentry): add user attribution to all authenticated requests

| Field | Value |
|-------|-------|
| **Author** | kiloconnect\[bot\] |
| **Timestamp** | 2026-03-10T15:58:42+00:00 |
| **Files** | `src/lib/user.server.ts` |

**What changed:** Added `setUser({ id: user.id, email: user.google_user_email, ip_address: '{{auto}}' })` to `validateUserAuthorization`. This sets Sentry user context on every authenticated request.

**Risk assessment:** **LOW-MEDIUM.** This runs on every authenticated request. If `setUser` throws or has performance overhead, it could degrade all authenticated routes. The `ip_address: '{{auto}}'` placeholder is Sentry-specific and should be resolved server-side, but warrants verification.

---

### 7. `5d81d4b7` + `904404a6` — Earlybird banner removal and partial restoration

| Field | Value |
|-------|-------|
| **Author** | kiloconnect\[bot\] |
| **Timestamps** | 13:37 UTC (removal), 13:57 UTC (restore) |
| **Files** | `src/app/(app)/claw/components/ClawDashboard.tsx`, `src/app/(app)/claw/earlybird/page.tsx`, `src/app/(app)/claw/components/EarlybirdBanner.tsx` |

**What changed:** First commit removed the EarlybirdBanner and replaced the earlybird purchase page with a "Sold Out" notice. Second commit (20 min later) re-added the banner but only for users who already purchased.

**Risk assessment:** **LOW.** Only affects KiloClaw dashboard UI. The earlybird page is now a dead-end for non-purchasers, which is intentional. No API or data flow changes.

---

## Medium-Risk Commits

### 8. `68d2f143` — Reduce Vercel routing when error rate is high

Same change as `d8ab39a8` (this is the branch commit; the merge is #981). See analysis above.

### 9. `06a1b002` + `a5949a41` + `1291d2a1` — Google Account section in Settings tab

| Field | Value |
|-------|-------|
| **Author** | Igor Šćekić |
| **Timestamps** | 14:58–15:29 UTC |
| **Files** | `src/app/(app)/claw/components/SettingsTab.tsx`, `src/hooks/useKiloClaw.ts`, `src/routers/kiloclaw-router.ts` |

**What changed:** Added a Google Account section to the KiloClaw Settings tab with docker setup command, copy button, and disconnect functionality. Added `connectGoogle`/`disconnectGoogle` mutations. Auto-fills API key in setup command.

**Risk assessment:** **LOW-MEDIUM.** New UI feature in KiloClaw settings. References `status.googleConnected` which must exist on the status type. If the property is missing, it could cause a runtime error on the settings tab for all KiloClaw users.

### 10. `07fe64c5` — fix(code-reviews): add time bound to billing query to avoid seq scan

| Field | Value |
|-------|-------|
| **Author** | Alex Alecu |
| **Timestamp** | 2026-03-10T15:28:53+02:00 (13:28 UTC) |
| **Files** | 6 files including schema, migration deletion, and query changes |

**What changed:** Removed migration `0049_colorful_vermin.sql` (session_id index), updated billing query to add `created_at` time bound, modified schema.

**Risk assessment:** **MEDIUM.** Migration removal could cause issues if the migration had already been applied in some environments but not others. The schema change touches `packages/db/src/schema.ts`.

---

## Low-Risk Commits (Admin-Only / Internal)

These commits only affect admin dashboards, internal tooling, or documentation, and are unlikely to impact user activation.

| Commit | Time (UTC) | Author | Description |
|--------|-----------|--------|-------------|
| `ce2b1aed` | 14:48 | kiloconnect\[bot\] | Add Sentry/PostHog/Pylon deep-links to admin user profile |
| `ecc49d11` | 15:55 | kiloconnect\[bot\] | Gate admin Restore Default Config behind controller version |
| `30bd7bf8` | 12:56 | Alex Alecu | Add agent version filter to code review backend |
| `8ce00eca` | 12:57 | Alex Alecu | Add agent version filter UI to code review dashboard |
| `6027e06e` | 12:58 | Alex Alecu | Show per-agent-version breakdown in code review KPI cards |
| `03739912` | 12:59 | Alex Alecu | Add performance percentile stats procedure |
| `4d3eeb42` | 13:01 | Alex Alecu | Add performance trend chart to code review dashboard |
| `bd19421a` | 13:03 | Alex Alecu | Categorize code review errors with SQL CASE WHEN |
| `82361c16` | 13:04 | Alex Alecu | Update error analysis UI with categorized error bars |
| `48db9b49` | 14:01 | Alex Alecu | Apply agentVersion filter to topUsers/topOrgs queries |
| `bc31cbaa` | 14:02 | Alex Alecu | Normalize NULL agent_version to 'v1' |
| `0ee001d1` | 14:02 | Alex Alecu | Use uncapped category totals for error detail percentages |
| `c9341378` | 14:09 | Alex Alecu | Group by COALESCE expression to merge NULL and v1 rows |
| `14e3045c` | 14:08 | Alex Alecu | Include NULL agent_version rows when filtering for v1 |
| `e2d7f2d0` | 14:19 | Alex Alecu | Limit performance stats to completed reviews only |
| `672d9c49` | 14:28 | Alex Alecu | Show error banner for all dashboard query failures |
| `592ca78c` | 14:28 | Alex Alecu | Use carry-aware rounding in duration formatter |
| `53aba34d` | 14:41 | Alex Alecu | Resolve contradictory skip vs review instructions for .sql |
| `bde2d47a` | 13:08 | Alex Alecu | Ignore migrations snapshots in code review prompts |
| `afdfc88e` | 13:04 | Alex Alecu | Review .sql migration files for production safety |
| `6070b3ab` | 14:14 | Alex Alecu | Add review detail page (#974) |
| `fdd19b3f` | 13:46 | Florian Hines | Add changelog entry for OpenClaw 2026.3.8 |
| `d36f7bd4` | 13:51 | Florian Hines | Resolve conflict, add OpenClaw 2026.3.8 changelog entry |
| `56174c63` | 15:52 | Florian Hines | Bump openclaw to version 2026.3.8 (#939) |
| `ec127939` | 13:37 | Igor Šćekić | Add gcloud to Docker image, own OAuth flow, and e2e test |
| `6f75aa99` | 15:28 | Igor Šćekić | Use GHCR for google-setup image and add publishing docs |

---

## Investigation Recommendations

Given the activation drop occurred at 16:00–19:00 UTC (one hour after the end of this commit window), the most likely culprits are:

1. **Vercel AI Gateway routing change (`d8ab39a8`)** — Raised Vercel traffic to 20% and changed error-rate fallback logic. If Vercel had elevated errors starting around 16:00 UTC, 20% of LLM requests would fail or degrade, directly impacting user activation (users can't complete onboarding tasks if the AI doesn't respond).

2. **Cloud agent wrapper startup changes (`62c44057` + `33e37308`)** — Added 1.5s retry delay + pre-flight checks to every cloud agent session start. If sandbox environments had any transient issues, the combined overhead could cause sessions to take significantly longer to start or fail outright, preventing users from activating.

3. **GitHub check run app type change (`0ca144fb`)** — If the downstream function wasn't updated to handle the new argument, code review check runs could silently fail, breaking the code review experience for GitHub users.

**Recommended next steps:**
- Check Vercel AI Gateway error rates between 16:00–19:00 UTC on March 10
- Check cloud agent session startup times and failure rates in the same window
- Check Sentry for new errors in `wrapper-client.ts` and `code-review-status/[reviewId]/route.ts`
- Verify that `setUser` in `user.server.ts` is not throwing on any requests
