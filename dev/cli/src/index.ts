#!/usr/bin/env bun
import { resolve as resolvePath } from "path";
import { up } from "./commands/up";
import { down } from "./commands/down";
import { status } from "./commands/status";
import { envCheck } from "./commands/env";
import { tunnel } from "./commands/tunnel";
import { logs } from "./commands/logs";
import { getServiceNames } from "./services/registry";
import * as ui from "./utils/ui";

const ROOT = resolvePath(import.meta.dir, "..", "..", "..");

const args = process.argv.slice(2);

let command = args[0];
let commandArgs = args.slice(1);
if (command === "dev") {
  command = args[1];
  commandArgs = args.slice(2);
}

async function main() {
  switch (command) {
    case "up":
      await up(commandArgs, ROOT);
      break;

    case "down":
      await down(ROOT);
      break;

    case "status":
      await status(ROOT);
      break;

    case "env":
      await envCheck(ROOT);
      break;

    case "tunnel":
      await tunnel(commandArgs, ROOT);
      break;

    case "logs":
    case "ls":
      await logs(commandArgs, ROOT);
      break;

    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;

    default:
      if (getServiceNames().includes(command!)) {
        await up([command!, ...commandArgs], ROOT);
      } else {
        ui.error(`Unknown command: "${command}"`);
        printHelp();
        process.exit(1);
      }
  }
}

function printHelp() {
  console.log(`
${ui.bold("kilo dev")} — Local development CLI

${ui.bold("Usage:")}
  pnpm kilo <command> [options]

${ui.bold("Commands:")}
  up [services...]   Start services (default: nextjs + infra)
  down               Stop Docker infrastructure (Ctrl+C stops dev servers)
  status             Show status of all services
  env check          Validate environment variables
  tunnel [--name N]  Start a cloudflared tunnel
  logs [service]     Tail service logs (or list services)

${ui.bold("Examples:")}
  pnpm kilo up                    Start Next.js + Postgres + Redis
  pnpm kilo up kiloclaw           Start KiloClaw + all its dependencies
  pnpm kilo up cloud-agent        Start Cloud Agent + dependencies
  pnpm kilo up kiloclaw gastown   Start multiple services
  pnpm kilo status                Check what's running
  pnpm kilo env check             Validate all .dev.vars files

${ui.bold("Services:")}
  ${getServiceNames().join(", ")}
`);
}

main().catch((err) => {
  ui.error(err.message);
  process.exit(1);
});
