import { services } from "../services/registry";
import * as docker from "../infra/docker";
import * as ui from "../utils/ui";

export async function status(root: string) {
  ui.header("Service Status");

  const pgHealthy = await docker.isHealthy(root, "postgres");
  const redisHealthy = await docker.isHealthy(root, "redis");

  console.log(
    `  ${pgHealthy ? ui.green("●") : ui.red("●")} postgres    ${pgHealthy ? "running" : "stopped"}`,
  );
  console.log(
    `  ${redisHealthy ? ui.green("●") : ui.red("●")} redis       ${redisHealthy ? "running" : "stopped"}`,
  );

  const portServices = services.filter((s) => s.port && s.type !== "infra");
  for (const svc of portServices) {
    const listening = await isPortListening(svc.port!);
    console.log(
      `  ${listening ? ui.green("●") : ui.dim("○")} ${svc.name.padEnd(12)} ${listening ? `port ${svc.port}` : ui.dim("not running")}`,
    );
  }

  console.log();
}

async function isPortListening(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data() {},
        open(s) { s.end(); },
        error() {},
      },
    });
    return true;
  } catch {
    return false;
  }
}
