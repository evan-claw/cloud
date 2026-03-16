import { startQuickTunnel, startNamedTunnel, updateDevVarsUrl } from "../infra/tunnel";
import * as ui from "../utils/ui";
import { join } from "path";

export async function tunnel(args: string[], root: string) {
  const nameIdx = args.indexOf("--name");
  const tunnelName = nameIdx !== -1 ? args[nameIdx + 1] : undefined;
  const port = 3000;

  if (tunnelName) {
    ui.header(`Starting named tunnel: ${tunnelName}`);
    startNamedTunnel(tunnelName);
  } else {
    ui.header("Starting quick tunnel");
    const result = await startQuickTunnel(port);
    if (result.url) {
      ui.success(`Tunnel URL: ${result.url}`);
      const devVarsPath = join(root, "kiloclaw", ".dev.vars");
      if (await Bun.file(devVarsPath).exists()) {
        await updateDevVarsUrl(devVarsPath, result.url);
      }
    } else {
      ui.warn("Could not capture tunnel URL within 30s");
      ui.warn("Check cloudflared output and manually update .dev.vars");
    }
  }

  await new Promise(() => {});
}
