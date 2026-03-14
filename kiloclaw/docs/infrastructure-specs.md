# KiloClaw Infrastructure Specs

Hosting and instance specifications for KiloClaw, derived from the codebase
configuration files. Source-of-truth references are listed for each value.

## Control Plane

| Component         | Provider                          | Details                                                      |
| ----------------- | --------------------------------- | ------------------------------------------------------------ |
| Worker runtime    | Cloudflare Workers                | Hono HTTP framework, `nodejs_compat` flag                    |
| Production domain | Cloudflare DNS                    | `claw.kilosessions.ai` (zone `kilosessions.ai`)              |
| Durable Objects   | Cloudflare                        | `KiloClawInstance`, `KiloClawApp` (both SQLite-backed)       |
| KV cache          | Cloudflare KV                     | Namespace `KV_CLAW_CACHE`                                    |
| Database          | Cloudflare Hyperdrive -> Postgres | Read-only from worker (pepper validation, instance registry) |

Source: `wrangler.jsonc`

## Compute — Fly.io Machines (per-user instances)

Each user gets a **dedicated Fly.io Machine** (Firecracker micro-VM). Machines are
created via the Fly Machines REST API, not Terraform or `flyctl`.

### Default Machine Spec

| Attribute    | Value                                      | Source                                                 |
| ------------ | ------------------------------------------ | ------------------------------------------------------ |
| CPU kind     | `shared`                                   | `src/config.ts:34` — `DEFAULT_MACHINE_GUEST.cpu_kind`  |
| vCPUs        | 2 (`shared-cpu-2x`)                        | `src/config.ts:32` — `DEFAULT_MACHINE_GUEST.cpus`      |
| RAM          | 3072 MB (3 GB)                             | `src/config.ts:33` — `DEFAULT_MACHINE_GUEST.memory_mb` |
| Approx. cost | ~$21.54/mo when running, free when stopped | `AGENTS.md`                                            |

### Configurable Machine Size Range

Per-user overrides are accepted via the `machineSize` provision parameter,
validated by `MachineSizeSchema` in `src/schemas/instance-config.ts:15-19`:

| Attribute | Min                       | Max           |
| --------- | ------------------------- | ------------- |
| vCPUs     | 1                         | 8             |
| RAM (MB)  | 256                       | 16384 (16 GB) |
| CPU kind  | `shared` or `performance` | —             |

### Machine Image

| Attribute     | Value                               | Source                                                |
| ------------- | ----------------------------------- | ----------------------------------------------------- |
| Base image    | `debian:bookworm-slim`              | `Dockerfile:1`                                        |
| Platform      | `linux/amd64`                       | `.github/workflows/deploy-kiloclaw.yml:133`           |
| Registry      | `registry.fly.io/kiloclaw-machines` | `wrangler.jsonc:70`, deploy workflow                  |
| Image tagging | Content-hash based (`img-{hash12}`) | Deploy workflow, deduplication via manifest inspect   |
| Node.js       | 22.22.1                             | `Dockerfile:4`                                        |
| Go            | 1.26.0                              | `Dockerfile:65`                                       |
| Bun           | 1.2.4 (build-time only)             | `Dockerfile:92`                                       |
| OpenClaw      | 2026.3.8                            | `Dockerfile:45`                                       |
| Kilo CLI      | 7.0.46                              | `Dockerfile:61`                                       |
| Chromium      | System package                      | `Dockerfile:8`                                        |
| Gateway port  | 18789                               | `src/config.ts:8` — `OPENCLAW_PORT`, `Dockerfile:135` |

### Machine Networking

| Attribute     | Value            | Source                                     |
| ------------- | ---------------- | ------------------------------------------ |
| External port | 443 (TLS + HTTP) | `src/durable-objects/machine-config.ts:40` |
| Internal port | 18789            | `src/durable-objects/machine-config.ts:41` |
| Protocol      | TCP              | `src/durable-objects/machine-config.ts:42` |
| Autostart     | `false`          | `src/durable-objects/machine-config.ts:43` |
| Autostop      | `off`            | `src/durable-objects/machine-config.ts:44` |

### Health Check

| Attribute    | Value           | Source                                        |
| ------------ | --------------- | --------------------------------------------- |
| Type         | HTTP GET        | `src/durable-objects/machine-config.ts:49-50` |
| Path         | `/_kilo/health` | `src/durable-objects/machine-config.ts:52`    |
| Port         | 18789           | `src/durable-objects/machine-config.ts:51`    |
| Interval     | 30s             | `src/durable-objects/machine-config.ts:53`    |
| Timeout      | 5s              | `src/durable-objects/machine-config.ts:54`    |
| Grace period | 120s            | `src/durable-objects/machine-config.ts:55`    |

## Storage — Fly Volumes

Each user gets a dedicated Fly Volume (NVMe-backed block storage), region-pinned.

| Attribute      | Value                                   | Source                                                     |
| -------------- | --------------------------------------- | ---------------------------------------------------------- |
| Default size   | 10 GB                                   | `src/config.ts:38` — `DEFAULT_VOLUME_SIZE_GB`              |
| Mount path     | `/root`                                 | `src/durable-objects/machine-config.ts:58`                 |
| Technology     | NVMe block storage                      | Fly.io platform                                            |
| Region pinning | Volume region determines machine region | `src/durable-objects/kiloclaw-instance/fly-machines.ts:44` |

## Fly.io Organization & Regions

| Attribute        | Value                                | Source                                  |
| ---------------- | ------------------------------------ | --------------------------------------- |
| Production org   | `kilo-679`                           | `wrangler.jsonc:71`                     |
| Development org  | `kilo-dev`                           | `DEVELOPMENT_LOCAL.md`                  |
| Default regions  | `dfw,ewr,iad,lax,sjc,eu`             | `wrangler.jsonc:73`, `src/config.ts:43` |
| Region selection | Shuffled priority list with fallback | `src/durable-objects/regions.ts`        |

Region codes: DFW (Dallas), EWR (Newark), IAD (Ashburn), LAX (Los Angeles),
SJC (San Jose), plus `eu` alias (all EU regions). ORD (Chicago) is omitted due
to provisioning issues (`src/config.ts:42`).

## Per-User App Isolation

Each user gets a dedicated Fly App, managed by the `KiloClawApp` Durable Object:

| Attribute             | Production                           | Development    |
| --------------------- | ------------------------------------ | -------------- |
| App name pattern      | `acct-{hash}`                        | `dev-{hash}`   |
| Shared image registry | `kiloclaw-machines`                  | `kiloclaw-dev` |
| Legacy fallback app   | `kiloclaw-machines` (`FLY_APP_NAME`) | —              |

## Reconciliation & Alarm Cadence

| Instance status           | Alarm interval | Source             |
| ------------------------- | -------------- | ------------------ |
| `running`                 | 5 min          | `src/config.ts:47` |
| `destroying`              | 1 min          | `src/config.ts:49` |
| `provisioned` / `stopped` | 30 min         | `src/config.ts:51` |
| Jitter                    | 0–60s random   | `src/config.ts:53` |

## CI/CD Pipeline

| Step          | Tool                                        | Details                                              |
| ------------- | ------------------------------------------- | ---------------------------------------------------- |
| Docker build  | GitHub Actions + `docker/build-push-action` | `linux/amd64`, GHA layer cache                       |
| Registry push | `registry.fly.io/kiloclaw-machines`         | Content-hash tag + `latest`                          |
| Worker deploy | Cloudflare Wrangler                         | `wrangler deploy` with image tag/digest/version vars |
| Trigger       | Push to `kiloclaw/` files on main           | `.github/workflows/deploy-production.yml`            |

## No Terraform / Kubernetes

The repository contains **no Terraform, Kubernetes, or IaC manifests** for KiloClaw.
All Fly.io resources (apps, machines, volumes, IPs) are managed imperatively via the
Fly Machines REST API from the Cloudflare Worker's Durable Objects at runtime.
