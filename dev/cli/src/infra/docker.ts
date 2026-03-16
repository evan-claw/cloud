import { run } from "../utils/process";

const COMPOSE_FILE = "dev/docker-compose.yml";

export async function startService(root: string, service: string): Promise<boolean> {
  return run({
    command: `docker compose -f ${COMPOSE_FILE} up -d ${service}`,
    cwd: root,
    label: `docker compose up -d ${service}`,
  });
}

export async function stopAll(root: string): Promise<boolean> {
  return run({
    command: `docker compose -f ${COMPOSE_FILE} down`,
    cwd: root,
    label: "docker compose down",
  });
}

export async function isHealthy(root: string, service: string): Promise<boolean> {
  try {
    if (service === "postgres") {
      const proc = Bun.spawn(
        ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "postgres", "pg_isready", "-U", "postgres"],
        { stdout: "pipe", stderr: "pipe", cwd: root },
      );
      return (await proc.exited) === 0;
    }
    if (service === "redis") {
      const proc = Bun.spawn(
        ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "redis", "redis-cli", "ping"],
        { stdout: "pipe", stderr: "pipe", cwd: root },
      );
      return (await proc.exited) === 0;
    }
    return false;
  } catch {
    return false;
  }
}

export async function waitForHealthy(root: string, service: string, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isHealthy(root, service)) return true;
    await Bun.sleep(500);
  }
  return false;
}
