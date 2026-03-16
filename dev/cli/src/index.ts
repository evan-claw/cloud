#!/usr/bin/env bun
import { resolve as resolvePath } from "path";
import { up } from "./commands/up";
import { down } from "./commands/down";
import { status } from "./commands/status";
import { envCheck } from "./commands/env";
import { tunnel } from "./commands/tunnel";
import { logs } from "./commands/logs";
import { getServiceNames } from "./services/registry";
import { getProject, getProjectNames, projects } from "./projects/index";
import * as ui from "./utils/ui";

const ROOT = resolvePath(import.meta.dir, "..", "..", "..");

const args = process.argv.slice(2);

// Support both `kilo dev up` and `kilo up` (skip "dev" if present)
let command = args[0];
let commandArgs = args.slice(1);
if (command === "dev") {
  command = args[1];
  commandArgs = args.slice(2);
}

async function main() {
  // Check if command is a project name with a subcommand
  // e.g. `kilo kiloclaw setup` or `kilo code-review up`
  if (command) {
    const project = getProject(command);
    if (project) {
      const subcommand = commandArgs[0];
      const subArgs = commandArgs.slice(1);

      if (subcommand && project.commands[subcommand]) {
        await project.commands[subcommand].run(subArgs, ROOT);
        return;
      }

      // Unknown subcommand — show error + project help
      if (subcommand) {
        ui.error(`Unknown command "${subcommand}" for project "${command}"`);
        console.log();
      }

      printProjectHelp(project);
      return;
    }
  }

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
      // Maybe they typed a service name directly? e.g. `kilo kiloclaw`
      if (getServiceNames().includes(command!)) {
        await up([command!, ...commandArgs], ROOT);
      } else {
        ui.error(`Unknown command: "${command}"`);
        printHelp();
        process.exit(1);
      }
  }
}

function printProjectHelp(project: import("./projects/types").ProjectDef) {
  const cmds = Object.entries(project.commands);
  console.log(`
${ui.bold(project.name)} — ${project.description}

${ui.bold("Commands:")}
${cmds.map(([name, cmd]) => `  ${name.padEnd(20)} ${cmd.description}`).join("\n")}

${ui.bold("Usage:")}
  pnpm kilo ${project.name} <command> [options]
`);
}

function printHelp() {
  const projectList = projects
    .map((p) => `  ${p.name.padEnd(20)} ${p.description}`)
    .join("\n");

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

${ui.bold("Projects:")}
${projectList}

${ui.bold("Examples:")}
  pnpm kilo up                       Start Next.js + Postgres + Redis
  pnpm kilo up kiloclaw              Start KiloClaw + all its dependencies
  pnpm kilo kiloclaw setup           KiloClaw-specific setup (Fly token, secrets)
  pnpm kilo kiloclaw push-dev        Build + push controller Docker image
  pnpm kilo code-review up           Start code review dev environment
  pnpm kilo app-builder up           Start app builder tmux session
  pnpm kilo status                   Check what's running
  pnpm kilo env check                Validate all .dev.vars files

${ui.bold("Services:")}
  ${getServiceNames().join(", ")}
`);
}

main().catch((err) => {
  ui.error(err.message);
  process.exit(1);
});
