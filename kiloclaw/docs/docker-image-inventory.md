# KiloClaw Docker Image Inventory

Comprehensive inventory of all pre-installed tools and binaries in the KiloClaw
Docker image, sourced from `kiloclaw/Dockerfile` and `kiloclaw/start-openclaw.sh`.

**Base image:** `debian:bookworm-slim`

---

## System Utilities (apt)

Installed via `apt-get install` in the initial `RUN` layer.

| Tool              | Version | Purpose                                                        |
| ----------------- | ------- | -------------------------------------------------------------- |
| `ca-certificates` | distro  | TLS certificate bundle for HTTPS                               |
| `curl`            | distro  | HTTP client (used for downloads during build)                  |
| `gnupg`           | distro  | GPG key management (APT repo signing)                          |
| `git`             | distro  | Version control (runtime: OpenClaw workspace ops)              |
| `unzip`           | distro  | Archive extraction                                             |
| `jq`              | distro  | JSON processor (used in `start-openclaw.sh` and scripts)       |
| `ripgrep`         | distro  | Fast recursive text search (runtime tool for agents)           |
| `rsync`           | distro  | File synchronization                                           |
| `zstd`            | distro  | Zstandard compression                                          |
| `build-essential` | distro  | C/C++ compiler toolchain (gcc, g++, make, libc-dev)            |
| `python3`         | distro  | Python interpreter (runtime dependency for native npm modules) |
| `ffmpeg`          | distro  | Audio/video processing                                         |
| `tmux`            | distro  | Terminal multiplexer                                           |

**Note:** `xz-utils` is installed temporarily for Node.js extraction and then
purged in the same layer.

---

## Programming Languages & Runtimes

| Tool        | Version                          | Install method                                           | Purpose                                                                          |
| ----------- | -------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Node.js** | `22.13.1` (pinned)               | Binary tarball from `nodejs.org`                         | Primary runtime — required by OpenClaw and the controller                        |
| **npm**     | ships with Node.js 22            | Bundled with Node.js                                     | Node package manager (used to install global packages)                           |
| **Go**      | `1.26.0` (pinned)                | Binary tarball from `dl.google.com/go`, SHA-256 verified | Available at runtime for `go install` of additional tools                        |
| **Bun**     | `1.2.4` (pinned, build-time ARG) | `bun.sh/install` script                                  | Used to compile the controller bundle; available at runtime via `/root/.bun/bin` |

---

## Package Managers

| Tool     | Version                   | Install method        | Purpose                                   |
| -------- | ------------------------- | --------------------- | ----------------------------------------- |
| **npm**  | (bundled with Node.js 22) | Included with Node.js | Installs global npm packages              |
| **pnpm** | latest at build time      | `npm install -g pnpm` | Node package manager (alternative to npm) |

---

## AI / OpenClaw Stack

These are the core tools that make the image function as a KiloClaw instance.

| Tool                    | Version              | Install method                                      | Purpose                                                                      |
| ----------------------- | -------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| **openclaw**            | `2026.3.2` (pinned)  | `npm install -g openclaw@2026.3.2`                  | AI assistant platform — gateway, channels, agent framework                   |
| **clawhub**             | latest at build time | `npm install -g clawhub`                            | ClawHub CLI — skill/plugin marketplace client                                |
| **mcporter**            | `0.7.3` (pinned)     | `npm install -g mcporter@0.7.3`                     | MCP (Model Context Protocol) server tooling                                  |
| **kiloclaw-controller** | build-date versioned | Bun-compiled from `controller/` source (Hono-based) | Supervisor daemon: proxies traffic, manages gateway lifecycle, health checks |

---

## CLI Tools (Go-based)

Installed via `go install` with `GOBIN=/usr/local/bin` so they survive the
Fly Volume mount at `/root`.

| Tool            | Version   | Source                                          | Purpose                                  |
| --------------- | --------- | ----------------------------------------------- | ---------------------------------------- |
| **gog**         | `v0.11.0` | `github.com/steipete/gogcli/cmd/gog`            | GOG Galaxy CLI (game library management) |
| **goplaces**    | `v0.3.0`  | `github.com/steipete/goplaces/cmd/goplaces`     | Location/places lookup CLI               |
| **blogwatcher** | `v0.0.2`  | `github.com/Hyaxia/blogwatcher/cmd/blogwatcher` | Blog/RSS monitoring                      |
| **xurl**        | `v1.0.3`  | `github.com/xdevplatform/xurl`                  | X/Twitter URL utility                    |
| **gifgrep**     | `v0.2.3`  | `github.com/steipete/gifgrep/cmd/gifgrep`       | GIF search CLI                           |

---

## CLI Tools (npm-based)

| Tool                    | Version           | Install method                              | Purpose                    |
| ----------------------- | ----------------- | ------------------------------------------- | -------------------------- |
| **@steipete/summarize** | `0.11.1` (pinned) | `npm install -g @steipete/summarize@0.11.1` | Web page summarization CLI |

---

## Cloud & Platform CLIs (apt)

Installed via APT from vendor repositories (GPG-signed).

| Tool                     | Version              | Install method      | Purpose                                |
| ------------------------ | -------------------- | ------------------- | -------------------------------------- |
| **gh**                   | latest at build time | GitHub CLI APT repo | GitHub API client (issues, PRs, repos) |
| **1password-cli** (`op`) | `2.32.1-1` (pinned)  | 1Password APT repo  | Secrets management CLI                 |

---

## Copied Scripts & Config

Files `COPY`ed into the image (not installable packages).

| File                              | Destination                                         | Purpose                                                                                       |
| --------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `start-openclaw.sh`               | `/usr/local/bin/start-openclaw.sh`                  | Container entrypoint: decrypts env vars, onboards OpenClaw, patches config, starts controller |
| `openclaw-pairing-list.js`        | `/usr/local/bin/openclaw-pairing-list.js`           | Lists pending channel pairing requests (Telegram, Discord, Slack)                             |
| `openclaw-device-pairing-list.js` | `/usr/local/bin/openclaw-device-pairing-list.js`    | Lists pending device pairing requests                                                         |
| `skills/`                         | `/root/clawd/skills/`                               | Custom skill definitions (currently `.gitkeep` only)                                          |
| `controller/`                     | compiled to `/usr/local/bin/kiloclaw-controller.js` | Controller source, compiled via Bun at build time                                             |

---

## Runtime Behavior Notes

- **Fly Volume at `/root`**: A persistent NVMe volume is mounted at `/root` at
  runtime, shadowing image-layer contents under `/root`. Pre-installed Go tools
  use `GOBIN=/usr/local/bin` to avoid this. User-installed tools via `go install`
  default to `/root/go/bin` and persist across restarts.
- **Go module/build cache**: Cleaned at build time (`go clean -cache -modcache`)
  to reduce image size.
- **Bun**: Installed to `/root/.bun/bin` — available at runtime if the volume is
  empty, but may be shadowed by the Fly Volume mount. Primarily a build-time tool.
- **Architecture support**: The Dockerfile handles both `amd64` and `arm64`, but
  CI builds target `linux/amd64` only.
- **Exposed port**: `18789` (controller proxy port; the OpenClaw gateway itself
  listens on `3001` on loopback).
