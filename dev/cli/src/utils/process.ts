import { type Subprocess } from "bun";

const runningProcesses: Subprocess[] = [];

function setupCleanup() {
  const handler = async () => {
    console.log("\n\x1b[90mStopping all services...\x1b[0m");
    for (const proc of runningProcesses) {
      proc.kill();
    }
    await Bun.sleep(3000);
    for (const proc of runningProcesses) {
      try { proc.kill(9); } catch {}
    }
    process.exit(0);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

let cleanupRegistered = false;

export function spawnService(opts: {
  name: string;
  command: string;
  cwd: string;
}): Subprocess {
  if (!cleanupRegistered) {
    setupCleanup();
    cleanupRegistered = true;
  }

  const proc = Bun.spawn(["sh", "-c", opts.command], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  pipeWithPrefix(proc.stdout, opts.name);
  pipeWithPrefix(proc.stderr, opts.name);

  runningProcesses.push(proc);
  return proc;
}

async function pipeWithPrefix(
  stream: ReadableStream<Uint8Array> | null,
  prefix: string,
) {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const color = nameToColor(prefix);
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line) {
        process.stdout.write(`${color}[${prefix}]${RESET} ${line}\n`);
      }
    }
  }
  if (buffer) {
    process.stdout.write(`${color}[${prefix}]${RESET} ${buffer}\n`);
  }
}

export async function run(opts: {
  command: string;
  cwd: string;
  label?: string;
}): Promise<boolean> {
  const label = opts.label ?? opts.command;
  console.log(`\x1b[90m$ ${label}\x1b[0m`);

  const proc = Bun.spawn(["sh", "-c", opts.command], {
    cwd: opts.cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  const code = await proc.exited;
  return code === 0;
}

export function killAll() {
  for (const proc of runningProcesses) {
    proc.kill();
  }
  runningProcesses.length = 0;
}

const COLORS = [
  "\x1b[36m", "\x1b[33m", "\x1b[35m", "\x1b[32m", "\x1b[34m",
  "\x1b[91m", "\x1b[92m", "\x1b[93m", "\x1b[94m", "\x1b[95m",
];
const RESET = "\x1b[0m";
const colorMap = new Map<string, string>();
let colorIdx = 0;

function nameToColor(name: string): string {
  if (!colorMap.has(name)) {
    colorMap.set(name, COLORS[colorIdx % COLORS.length]!);
    colorIdx++;
  }
  return colorMap.get(name)!;
}
