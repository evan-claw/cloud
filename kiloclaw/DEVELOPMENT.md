# KiloClaw Development Guide

## Prerequisites

- Node.js 22+
- pnpm
- [Fly CLI](https://fly.io/docs/flyctl/install/) (`fly`)
- Docker (for building/pushing images)
- Access to the **Kilo (dev)** Fly org
- A Cloudflare tunnel or ngrok (so Fly machines can call back to your local Next.js)

## Quick Start

```bash
# Install dependencies (run from monorepo root)
pnpm install

# Copy the example env file
cp .dev.vars.example .dev.vars

# Edit .dev.vars -- see "Environment Variables" below
```

## How it fits together

KiloClaw is a Cloudflare Worker that manages per-user OpenClaw instances on
Fly.io Machines. In local dev there are three moving pieces:

1. **Next.js app** (`localhost:3000`) -- the dashboard and platform API.
   Provisions/starts/stops instances by calling the worker's internal API.
2. **KiloClaw worker** (`localhost:8795`) -- `wrangler dev`. Manages Fly
   machines, proxies browser traffic to them.
3. **Fly Machines** (remote) -- the actual OpenClaw instances. They call
   back to your Next.js app (via the KiloCode gateway) for model requests.

Because Fly machines are remote, they can't reach `localhost:3000` directly.
You need a tunnel so that `KILOCODE_API_BASE_URL` resolves to your local
Next.js from the internet.

### Tunnel setup

Use Cloudflare Tunnel (recommended) or ngrok to expose your local Next.js:

```bash
# Cloudflare Tunnel (free, no account needed for quick tunnels)
cloudflared tunnel --url http://localhost:3000

# Or ngrok
ngrok http 3000
```

Copy the tunnel URL and set it in `.dev.vars`:

```
KILOCODE_API_BASE_URL=https://<your-tunnel>.trycloudflare.com/api/openrouter/
```

## Environment Variables

There are two env files to configure:

### 1. `kiloclaw/.dev.vars` (worker secrets)

Copy `.dev.vars.example` and fill in:

**Auth** -- must match the Next.js app's values:

| Variable               | Description                                                         |
| ---------------------- | ------------------------------------------------------------------- |
| `NEXTAUTH_SECRET`      | JWT signing key. Must match the Next.js app's `NEXTAUTH_SECRET`     |
| `INTERNAL_API_SECRET`  | Platform API key. Must match Next.js `KILOCLAW_INTERNAL_API_SECRET` |
| `GATEWAY_TOKEN_SECRET` | HMAC key for per-sandbox gateway tokens (worker-only)               |
| `WORKER_ENV`           | Set to `development` for local dev                                  |

**Fly.io** -- requires access to the Kilo (dev) org:

| Variable           | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| `FLY_API_TOKEN`    | Fly API token. Generate with `fly tokens create dev-token`                |
| `FLY_ORG_SLUG`     | Fly org slug for the dev org (run `fly orgs list`)                        |
| `FLY_REGISTRY_APP` | Shared Fly app that holds Docker images                                   |
| `FLY_APP_NAME`     | Legacy fallback app name for existing instances                           |
| `FLY_REGION`       | Default region priority list, e.g. `us,eu`                                |
| `FLY_IMAGE_TAG`    | Docker image tag. Set automatically by `scripts/push-dev.sh`              |
| `FLY_IMAGE_DIGEST` | Docker image digest. Set automatically by `scripts/push-dev.sh`           |
| `OPENCLAW_VERSION` | OpenClaw version in the image. Set automatically by `scripts/push-dev.sh` |

**Tunnel / API** -- so Fly machines can reach your local Next.js:

| Variable                | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `KILOCODE_API_BASE_URL` | Your tunnel URL + `/api/openrouter/` (see tunnel setup above) |

**Encryption** -- for decrypting user-provided secrets:

| Variable                     | Description                                                       |
| ---------------------------- | ----------------------------------------------------------------- |
| `AGENT_ENV_VARS_PRIVATE_KEY` | RSA private key (PEM). Matching public key is in the Next.js app. |

**Other:**

| Variable                   | Description                                       |
| -------------------------- | ------------------------------------------------- |
| `OPENCLAW_ALLOWED_ORIGINS` | Comma-separated origins for WebSocket connections |

### 2. `.env.development.local` (Next.js, monorepo root)

The Next.js app needs to know how to reach the KiloClaw worker:

| Variable                       | Description                                     |
| ------------------------------ | ----------------------------------------------- |
| `KILOCLAW_API_URL`             | Worker URL, e.g. `http://localhost:8795`        |
| `KILOCLAW_INTERNAL_API_SECRET` | Must match `INTERNAL_API_SECRET` in `.dev.vars` |

## Building and Pushing Images

Before you can provision instances, you need a Docker image in the Fly registry.

```bash
# Authenticate Docker with Fly registry (one-time)
fly auth docker

# Build, push, and update .dev.vars with the new tag/digest/version
./scripts/push-dev.sh
```

`push-dev.sh` will:

1. Build the Docker image for `linux/amd64`
2. Push it to `registry.fly.io/{FLY_REGISTRY_APP}:{tag}`
3. Auto-update `FLY_IMAGE_TAG`, `FLY_IMAGE_DIGEST`, and `OPENCLAW_VERSION` in `.dev.vars`

After pushing, restart `wrangler dev` to pick up the new values. Then
destroy and re-provision your instance from the dashboard (or restart it).

## Running

```bash
# Start the worker (from kiloclaw/)
pnpm start
```

This runs `wrangler dev` on port 8795. Make sure your Next.js app is also
running on `localhost:3000` and your tunnel is active.

## Commands

```bash
pnpm start            # wrangler dev (local development)
pnpm typecheck        # tsgo --noEmit
pnpm lint             # eslint
pnpm lint:fix         # eslint --fix
pnpm format           # prettier --write
pnpm format:check     # prettier --check
pnpm test             # vitest run
pnpm test:watch       # vitest (watch mode)
pnpm test:coverage    # vitest --coverage
pnpm types            # regenerate worker-configuration.d.ts
pnpm deploy           # wrangler deploy
```

Run `pnpm types` after changing `wrangler.jsonc` to regenerate TypeScript
binding types.

## Controller Smoke Tests (Docker)

These scripts validate the machine-side Node controller. Build the image
first from `kiloclaw/`:

```bash
docker build --progress=plain -t kiloclaw:controller .
```

Then run one of:

- `bash scripts/controller-smoke-test.sh` -- direct controller startup.
  Use for quick auth/proxy sanity checks.
- `bash scripts/controller-entrypoint-smoke-test.sh` -- full startup path
  via `start-openclaw.sh`. Use when changing startup script or Docker wiring.
- `bash scripts/controller-proxy-auth-smoke-test.sh` -- proxy enforcement
  semantics (401 without token, pass-through with token). Use when changing
  proxy token logic.

All scripts support overrides via env vars (`IMAGE`, `PORT`, `TOKEN`).

## Troubleshooting

**Fly machine can't reach your Next.js:** Make sure your tunnel is running
and `KILOCODE_API_BASE_URL` in `.dev.vars` points to the tunnel URL. OpenClaw will probably
fail silently or complain that your model requires auth.

**Typecheck fails after changing wrangler.jsonc:** Run `pnpm types` to
regenerate `worker-configuration.d.ts`.

**Instance won't start / provision fails:** Check that `FLY_API_TOKEN` is
valid and your Fly org has capacity. Check `FLY_IMAGE_TAG` and
`FLY_IMAGE_DIGEST` match a pushed image.
