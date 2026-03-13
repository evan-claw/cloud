# Gmail Push - Cloudflare Worker

Receives Gmail push notifications from Google Cloud Pub/Sub and forwards them to the user's kiloclaw bot controller, waking the bot's main session when new emails arrive.

## Architecture

```
Gmail API → Pub/Sub topic → Push subscription → this worker
  → service binding → kiloclaw DO (status + gateway token lookup)
  → fly-force-instance-id → controller /_kilo/gmail-pubsub
  → gog gmail watch serve (localhost:3002)
```

## Authentication

Push requests are authenticated in two layers:

1. **HMAC URL token** (required): Each push subscription URL embeds `HMAC-SHA256(INTERNAL_API_SECRET, userId)[:32]`. Generated during Google account setup.
2. **Google OIDC JWT** (optional, defense-in-depth): If the Pub/Sub subscription is configured with `--push-auth-service-account`, Google signs push requests with a JWT. The worker validates it against Google's JWKS.

## API Endpoints

| Endpoint                    | Method | Auth                       | Description          |
| --------------------------- | ------ | -------------------------- | -------------------- |
| `/health`                   | GET    | None                       | Health check         |
| `/push/user/:userId/:token` | POST   | HMAC token + optional OIDC | Receive Pub/Sub push |

## Development

### Local Secrets Setup

Copy `.dev.vars.example` to `.dev.vars` and fill in the secret value (must match kiloclaw's `INTERNAL_API_SECRET`):

```bash
cp .dev.vars.example .dev.vars
```

### Running Tests

```bash
pnpm test
```

### Linting & Type Checking

```bash
pnpm lint
pnpm typecheck
```

### Local E2E Testing

Requires: kiloclaw worker running locally, a provisioned bot on Fly with the gmail-push controller image, and a Cloudflare Tunnel for public ingress.

**Terminal 1** - Run kiloclaw worker locally:

```bash
cd kiloclaw && wrangler dev --env dev
```

**Terminal 2** - Run this worker locally (service binding auto-discovers local kiloclaw):

```bash
cd cloudflare-gmail-push && wrangler dev --env dev
```

**Terminal 3** - Expose via CF tunnel:

```bash
cloudflared tunnel --url http://localhost:8787
```

**Push the controller image** (needed for the Fly machine to have the gmail-push route):

```bash
cd kiloclaw && ./scripts/push-dev.sh kiloclaw-machines-dev
```

**Connect Google account** with Pub/Sub setup by passing these env vars to the setup container:

```bash
GMAIL_PUSH_WORKER_URL=https://<tunnel-hostname>.trycloudflare.com
INTERNAL_API_SECRET=<value-from-.dev.vars>
```

Then enable notifications in the Settings UI and send an email to the connected Gmail account.

### Quick Smoke Test (no Pub/Sub needed)

Generate an HMAC token and curl the local worker directly:

```bash
# Generate token
TOKEN=$(node -e "
  const {createHmac} = require('crypto');
  const userId = '<your-user-id>';
  const secret = '<INTERNAL_API_SECRET>';
  console.log(createHmac('sha256', secret).update(userId).digest('hex').slice(0,32));
")

# Hit the push endpoint
curl -X POST "http://localhost:8787/push/user/<your-user-id>/$TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":{"data":"eyJoaXN0b3J5SWQiOjEyMzR9","messageId":"test-123"}}'
```

Expected: `{"ok":true}` if the bot is running, `{"ok":true,"skipped":"machine-not-running"}` if not.

### Tunnel URL changes

If you restart `cloudflared`, update the Pub/Sub subscription to point to the new URL:

```bash
gcloud pubsub subscriptions update gog-gmail-push \
  --push-endpoint="https://<new-tunnel>.trycloudflare.com/push/user/<userId>/<token>"
```

Use a named tunnel with a stable hostname to avoid this.

## Deployment

### Development

```bash
wrangler deploy --env dev
```

Deploys to: `cloudflare-gmail-push-dev`

### Production

```bash
wrangler deploy
```

Deploys to: `cloudflare-gmail-push`

## Secrets (via Secrets Store)

| Secret                | Description                                                      |
| --------------------- | ---------------------------------------------------------------- |
| `INTERNAL_API_SECRET` | Shared secret for service binding auth and HMAC token derivation |

## Environment Variables

| Variable        | Description                                              |
| --------------- | -------------------------------------------------------- |
| `OIDC_AUDIENCE` | Expected audience claim for optional OIDC JWT validation |

## Service Bindings

| Binding    | Target Worker  | Environment |
| ---------- | -------------- | ----------- |
| `KILOCLAW` | `kiloclaw`     | Production  |
| `KILOCLAW` | `kiloclaw-dev` | Development |
