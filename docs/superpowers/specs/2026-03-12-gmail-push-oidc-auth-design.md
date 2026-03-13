# Gmail Push Auth: Drop HMAC, Mandate OIDC

## Problem

The current push endpoint uses two auth layers:

1. **HMAC-SHA256 URL token** (mandatory) — derived from `INTERNAL_API_SECRET`
2. **Google OIDC JWT** (optional) — validated if present, skipped if missing

This has two issues:

- The google-setup Docker image needs `INTERNAL_API_SECRET` to derive the HMAC token for the Pub/Sub subscription URL. No secret should be baked into or required by the Docker image.
- OIDC is stronger than the HMAC token (cryptographically signed by Google, short-lived, audience-scoped) but is currently optional.

## Solution

- **Remove** the HMAC URL token entirely. Delete `push-token.ts`.
- **Make OIDC mandatory**. Every push request must carry a valid Google OIDC JWT.
- **Use Google-managed SA** (`gmail-api-push@system.gserviceaccount.com`) — zero setup, audience claim scopes requests to our deployment.
- **Keep `INTERNAL_API_SECRET`** in the worker — it's still used by `consumer.ts` for authenticating to kiloclaw's platform API (`x-internal-api-key` header). Only the push route stops using it.

## Auth Flow (After)

```
Google Pub/Sub
  |
  | Authorization: Bearer <OIDC JWT>
  v
POST /push/user/:userId
  | Validate OIDC JWT (mandatory):
  |   - Issuer: accounts.google.com
  |   - Audience: OIDC_AUDIENCE (per-environment)
  |   - Email: gmail-api-push@system.gserviceaccount.com
  |   - email_verified: true
  | Payload size guard (65KB)
  | Enqueue { userId, pubSubBody }
  | Return 200
```

The userId in the URL is still needed — Google's push payload identifies the user, but we need the userId for queue routing before parsing the payload.

## Changes

### `src/routes/push.ts`

- Route changes from `/user/:userId/:token` to `/user/:userId`
- Remove HMAC token verification
- Make OIDC validation mandatory (remove the `if (authHeader)` conditional)
- Hardcode `OIDC_ALLOWED_EMAIL` to `gmail-api-push@system.gserviceaccount.com` (no need for it to be configurable — this is Google's fixed SA for Pub/Sub push)

### `src/auth/push-token.ts`

Delete this file entirely.

### `src/auth/oidc.ts`

No changes needed. The `validateOidcToken` function already handles mandatory validation correctly — the caller just needs to stop treating missing headers as acceptable.

### `src/types.ts`

Remove `OIDC_ALLOWED_EMAIL` (hardcoded now). Keep `INTERNAL_API_SECRET` — it's used by the consumer for kiloclaw service binding auth.

```typescript
export type Env = {
  KILOCLAW: Fetcher;
  OIDC_AUDIENCE: string;
  INTERNAL_API_SECRET: string;
  GMAIL_PUSH_QUEUE: Queue<GmailPushQueueMessage>;
};
```

### `wrangler.jsonc`

Keep `secrets_store_secrets` blocks for `INTERNAL_API_SECRET` (still needed by consumer). No wrangler changes needed for secrets.

### `kiloclaw/google-setup/setup.mjs`

Lines 481-522: Replace the HMAC token generation block with OIDC-configured subscription creation:

- Remove `INTERNAL_API_SECRET` requirement
- Push URL becomes `${gmailPushWorkerUrl}/push/user/${pushUserId}` (no token suffix)
- Add `--push-auth-service-account=gmail-api-push@system.gserviceaccount.com` and `--push-auth-token-audience=${gmailPushWorkerUrl}` to the `gcloud pubsub subscriptions create/update` commands

The audience passed to `--push-auth-token-audience` **must exactly match** the worker's `OIDC_AUDIENCE` env var:

- Prod: `https://gmail-push.kilocode.workers.dev`
- Dev: `https://gmail-push-dev.kilocode.workers.dev`

Note: this is the `.workers.dev` URL, not the `kiloapps.ai` custom domain. The setup script should derive this from `OIDC_AUDIENCE`, not from `gmailPushWorkerUrl`.

### Tests

- **`src/routes/push.test.ts`**: Update route path (remove `:token` param). All requests must now include a valid OIDC Bearer token. Remove any HMAC-related test cases. Add test: request without Authorization header returns 401.
- **`src/auth/oidc.test.ts`**: No changes needed (already covers all validation scenarios).
- Remove any push-token tests if they exist.

### `docs/superpowers/specs/2026-03-12-gmail-push-queue-design.md`

Update the architecture diagram and "What Doesn't Change" section to reflect OIDC-only auth.

## What Doesn't Change

- Queue architecture (producer/consumer split)
- Consumer delivery logic and retry policy
- Controller-side gateway token auth (`/_kilo/gmail-pubsub`)
- Service binding to kiloclaw
- Payload size guard
- OIDC validation logic itself (just how it's called)

## Security Properties

- **Stronger than before**: OIDC JWTs are cryptographically signed, short-lived, and audience-scoped. The HMAC token was a static derivation that never expired.
- **No secrets in Docker image**: The setup script no longer needs any worker secrets.
- **Audience scoping**: Even if someone has a valid Google Pub/Sub push token for a different service, the audience claim prevents it from being used against our endpoint.
- **Email pinning**: Only `gmail-api-push@system.gserviceaccount.com` is accepted — not any Google SA.
