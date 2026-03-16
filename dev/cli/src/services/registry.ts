export type ServiceType = "infra" | "app" | "worker";

export interface ServiceDef {
  name: string;
  type: ServiceType;
  dir: string; // relative to monorepo root
  port?: number;
  devCommand?: string; // command to run in `dir`
  deps: string[];
  envFile?: string; // path to .dev.vars.example relative to dir
  description: string;
}

export const services: ServiceDef[] = [
  // --- Infrastructure ---
  {
    name: "postgres",
    type: "infra",
    dir: ".",
    devCommand: "docker compose -f dev/docker-compose.yml up -d postgres",
    deps: [],
    description: "PostgreSQL 18 + pgvector",
  },
  {
    name: "redis",
    type: "infra",
    dir: ".",
    devCommand: "docker compose -f dev/docker-compose.yml up -d redis",
    deps: [],
    description: "Redis 7",
  },
  {
    name: "migrations",
    type: "infra",
    dir: ".",
    devCommand: "pnpm drizzle migrate",
    deps: ["postgres"],
    description: "Drizzle database migrations",
  },

  // --- Core App ---
  {
    name: "nextjs",
    type: "app",
    dir: ".",
    port: 3000,
    devCommand: "pnpm dev",
    deps: ["postgres", "redis", "migrations"],
    description: "Next.js dashboard + API (port 3000)",
  },

  // --- Workers ---
  {
    name: "cloud-agent",
    type: "worker",
    dir: "cloud-agent",
    port: 8788,
    devCommand: "pnpm dev",
    deps: ["nextjs"],
    envFile: ".dev.vars.example",
    description: "CLI agent orchestration (Durable Objects + Containers)",
  },
  {
    name: "cloud-agent-next",
    type: "worker",
    dir: "cloud-agent-next",
    port: 8794,
    devCommand: "pnpm dev",
    deps: ["nextjs"],
    envFile: ".dev.vars.example",
    description: "Next-gen CLI agent orchestration",
  },
  {
    name: "session-ingest",
    type: "worker",
    dir: "cloudflare-session-ingest",
    port: 8787,
    devCommand: "pnpm dev",
    deps: ["nextjs"],
    description: "Session data ingestion",
  },
  {
    name: "code-review",
    type: "worker",
    dir: "cloudflare-code-review-infra",
    port: 8789,
    devCommand: "pnpm dev",
    deps: ["nextjs"],
    envFile: ".dev.vars.example",
    description: "Automated code reviews",
  },
  {
    name: "app-builder",
    type: "worker",
    dir: "cloudflare-app-builder",
    port: 8790,
    devCommand: "pnpm dev",
    deps: ["nextjs"],
    envFile: ".dev.vars.example",
    description: "App Builder sandbox",
  },
  {
    name: "auto-triage",
    type: "worker",
    dir: "cloudflare-auto-triage-infra",
    port: 8791,
    devCommand: "pnpm dev",
    deps: ["nextjs"],
    envFile: ".dev.vars.example",
    description: "Auto-triage for security findings",
  },
  {
    name: "auto-fix",
    type: "worker",
    dir: "cloudflare-auto-fix-infra",
    port: 8792,
    devCommand: "pnpm dev",
    deps: ["nextjs"],
    envFile: ".dev.vars.example",
    description: "Auto-fix for security findings",
  },
  {
    name: "webhook-agent",
    type: "worker",
    dir: "cloudflare-webhook-agent-ingest",
    port: 8793,
    devCommand: "pnpm dev",
    deps: ["nextjs"],
    envFile: ".dev.vars.example",
    description: "Incoming webhook processing",
  },
  {
    name: "kiloclaw",
    type: "worker",
    dir: "kiloclaw",
    port: 8795,
    devCommand: "pnpm dev",
    deps: ["nextjs"],
    envFile: ".dev.vars.example",
    description: "OpenClaw AI assistant (proxies to Fly.io)",
  },
  {
    name: "gastown",
    type: "worker",
    dir: "cloudflare-gastown",
    devCommand: "pnpm dev",
    deps: ["nextjs"],
    description: "AI agent orchestration via Durable Objects",
  },
  {
    name: "db-proxy",
    type: "worker",
    dir: "cloudflare-db-proxy",
    port: 8792,
    devCommand: "pnpm dev",
    deps: ["postgres"],
    envFile: ".dev.vars.example",
    description: "Database proxy service",
  },
  {
    name: "git-token",
    type: "worker",
    dir: "cloudflare-git-token-service",
    port: 8795,
    devCommand: "pnpm dev",
    deps: [],
    envFile: ".dev.vars.example",
    description: "Git token management",
  },
  {
    name: "o11y",
    type: "worker",
    dir: "cloudflare-o11y",
    devCommand: "pnpm dev",
    deps: [],
    description: "Observability / analytics",
  },
  {
    name: "images-mcp",
    type: "worker",
    dir: "cloudflare-images-mcp",
    port: 8796,
    devCommand: "pnpm dev",
    deps: [],
    envFile: ".dev.vars.example",
    description: "MCP for image handling",
  },
  {
    name: "security-sync",
    type: "worker",
    dir: "cloudflare-security-sync",
    devCommand: "pnpm dev",
    deps: [],
    description: "Security synchronization",
  },
  {
    name: "security-analysis",
    type: "worker",
    dir: "cloudflare-security-auto-analysis",
    port: 8797,
    devCommand: "pnpm dev",
    deps: [],
    description: "Security auto-analysis",
  },
  {
    name: "ai-attribution",
    type: "worker",
    dir: "cloudflare-ai-attribution",
    devCommand: "pnpm dev",
    deps: [],
    description: "AI model attribution",
  },
  {
    name: "gmail-push",
    type: "worker",
    dir: "cloudflare-gmail-push",
    devCommand: "pnpm dev",
    deps: ["nextjs"],
    description: "Gmail push notifications",
  },
];

export function getService(name: string): ServiceDef | undefined {
  return services.find((s) => s.name === name);
}

export function getServiceNames(): string[] {
  return services.map((s) => s.name);
}
