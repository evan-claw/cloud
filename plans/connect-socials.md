# Connect Socials to Kilo Accounts

Spec: [Connecting Socials to Kilo Accounts](https://docs.google.com/document/d/...) (Google Doc)

## Spec → Planned Features → Implementation Status

### User Profile Fields

| Spec Requirement                                     | Planned Feature                                                                       | Status         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------- |
| LinkedIn Profile URL field on profile page           | Display + edit in `UserProfileCard` with `EditProfileDialog`                          | ✅ Implemented |
| GitHub Profile URL field on profile page             | Display + edit in `UserProfileCard` with `EditProfileDialog`                          | ✅ Implemented |
| Backend storage for LinkedIn/GitHub URLs             | `linkedin_url` and `github_url` columns on `kilocode_users`                           | ✅ Implemented |
| Flow to collect URLs on user signup                  | N/A per spec — marked "(not required)"                                                | ✅ N/A         |
| Edit/save URLs on profile page (pencil icon → modal) | `EditProfileDialog` with URL validation, `user.updateProfile` tRPC mutation           | ✅ Implemented |
| (Optional) Validate URLs are real profiles           | Client-side URL format + protocol validation in dialog and server-side Zod validation | ✅ Implemented |

### Organization Company Domain

| Spec Requirement                                 | Planned Feature                                                           | Status         |
| ------------------------------------------------ | ------------------------------------------------------------------------- | -------------- |
| "Company domain" field on organization info card | Inline-editable field in `OrganizationInfoCard`                           | ✅ Implemented |
| Flow to collect domain on org creation           | "Company Website" input on `/organizations/new` creation form             | ✅ Implemented |
| Backend storage for company domain               | `company_domain` column on `organizations` table                          | ✅ Implemented |
| Edit domain on organization page                 | Inline edit with `normalizeCompanyDomain()` + `isValidDomain()`           | ✅ Implemented |
| (Optional) Validate it's a real domain           | `CompanyDomainSchema` (Zod), `isValidDomain()` regex, 233-line test suite | ✅ Implemented |

### Next Iteration — GitHub Auto-Linking

| Spec Requirement                                                                | Planned Feature                            | Status |
| ------------------------------------------------------------------------------- | ------------------------------------------ | ------ |
| Auto-link GH profile on GH signup (`user:read` scope)                           | N/A — deferred per spec ("Next iteration") | N/A    |
| Auto-link GH profile via configured GH integration (match org members by email) | N/A — deferred per spec ("Next iteration") | N/A    |

### Next Iteration — Discord Account Linking

| Spec Requirement                                             | Planned Feature                                                                                      | Status         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------- |
| Discord as auth provider (OAuth `identify+email`)            | Add `DiscordProvider` to NextAuth, `createDiscordAccountInfo()`, add `'discord'` to `AuthProviderId` | ✅ Implemented |
| Discord on sign-in/sign-up page                              | Add to `AllAuthProviders` in `provider-metadata.tsx` (auto-propagates to sign-in page)               | ✅ Implemented |
| Discord on Connected Accounts page (link/unlink)             | Same as above — `LinkableAuthProviders` derives from `AllAuthProviders` automatically                | ✅ Implemented |
| Discord logo component                                       | New `DiscordLogo.tsx` SVG component in `src/components/auth/`                                        | ✅ Implemented |
| Store Discord identity (user ID, username, avatar)           | Stored in `user_auth_provider` via standard provider pattern                                         | ✅ Implemented |
| Store `discord_linked_at`                                    | `user_auth_provider.created_at` serves this purpose                                                  | ✅ Automatic   |
| GDPR soft-delete for Discord fields                          | `softDeleteUser()` already deletes all `user_auth_provider` rows; new guild columns need nullifying  | ✅ Implemented |
| Confirm user is in Kilo Discord server (bot check)           | `checkDiscordGuildMembership()` via Bot API, `user.verifyDiscordGuildMembership` tRPC mutation       | ✅ Implemented |
| `discord_server_member` + `discord_server_member_at` columns | New nullable columns on `kilocode_users` for guild membership status                                 | ✅ Implemented |
| "Verify Discord Server Membership" UI                        | `DiscordGuildStatus` component on `/connected-accounts` page                                         | ✅ Implemented |
| Require email for Discord linking                            | Reject linking if Discord doesn't return a verified email (`createDiscordAccountInfo` returns null)  | ✅ Implemented |

## Implementation Plan

6 tasks across 4 waves. All work is in the Discord section above.

### Wave 1 — Schema & Types

**Task 1: Add Discord to auth provider type system + guild membership columns**

- `packages/db/src/schema-types.ts` — add `'discord'` to `AuthProviderId`
- `packages/db/src/schema.ts` — add `discord_server_member` (boolean, nullable) and `discord_server_member_at` (timestamptz, nullable) to `kilocode_users`
- `src/lib/auth/constants.ts` — add `discord: '@@discord@@'` to `hosted_domain_specials`
- Generate migration via `pnpm drizzle-kit generate`
- `src/lib/user.ts` — update `softDeleteUser()` to null out Discord columns
- `src/lib/user.test.ts` — assert GDPR soft-delete clears Discord fields
- `src/tests/helpers/user.helper.ts` — add defaults for new fields

### Wave 2 — Backend (parallel)

**Task 2: Add Discord as a NextAuth auth provider**

- `src/lib/user.server.ts` — import `DiscordProvider`, add `createDiscordAccountInfo()`, wire into `createAccountInfo()` chain, add to providers array
- `src/lib/config.server.ts` — add `DISCORD_SERVER_ID` env var
- Reject linking if Discord doesn't provide email

### Wave 3 — Frontend + Guild Verification (parallel)

**Task 3: Discord logo + provider metadata**

- `src/components/auth/DiscordLogo.tsx` — new SVG component
- `src/lib/auth/provider-metadata.tsx` — add Discord entry to `AllAuthProviders`

**Task 4: Discord guild membership verification — backend**

- `src/lib/integrations/discord-guild-membership.ts` — `checkDiscordGuildMembership()` function
- `src/routers/user-router.ts` — add `user.getDiscordGuildStatus` query + `user.verifyDiscordGuildMembership` mutation

**Task 5: Discord guild verification UI**

- `src/components/profile/DiscordGuildStatus.tsx` — new component
- `src/components/profile/LoginMethodsWrapper.tsx` — render guild status below existing cards

### Wave 4 — Verification

**Task 6: Typecheck, lint, tests**

- `pnpm typecheck`, `pnpm lint`, relevant test suites
- Verify no regressions, new Discord type propagates cleanly
