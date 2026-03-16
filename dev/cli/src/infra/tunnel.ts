import * as ui from '../utils/ui';
import { type Subprocess } from 'bun';

export interface TunnelResult {
  process: Subprocess;
  url?: string;
}

export async function startQuickTunnel(port: number): Promise<TunnelResult> {
  const command = `cloudflared tunnel --url http://localhost:${port}`;
  const proc = Bun.spawn(['sh', '-c', command], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });

  const url = await captureUrl(proc.stderr, 30_000);
  return { process: proc, url: url ?? undefined };
}

export function startNamedTunnel(name: string): Subprocess {
  return Bun.spawn(['sh', '-c', `cloudflared tunnel run ${name}`], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
}

async function captureUrl(
  stream: ReadableStream<Uint8Array> | null,
  timeoutMs: number
): Promise<string | null> {
  if (!stream) return null;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const start = Date.now();
  let buffer = '';

  while (Date.now() - start < timeoutMs) {
    const result = await Promise.race([
      reader.read(),
      Bun.sleep(timeoutMs - (Date.now() - start)).then(() => ({
        done: true as const,
        value: undefined,
      })),
    ]);

    if (result.value) {
      const text = decoder.decode(result.value, { stream: true });
      buffer += text;
      process.stderr.write(text);
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        pipeRemainingStderr(reader);
        return match[0];
      }
    }
    if (result.done) break;
  }

  return null;
}

async function pipeRemainingStderr(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    process.stderr.write(decoder.decode(value, { stream: true }));
  }
}

export async function updateDevVarsUrl(devVarsPath: string, tunnelUrl: string): Promise<void> {
  const apiUrl = `${tunnelUrl}/api/gateway/`;
  const file = Bun.file(devVarsPath);
  let content = await file.text();

  const pattern = /^(#\s*)?KILOCODE_API_BASE_URL=.*/m;
  if (pattern.test(content)) {
    content = content.replace(pattern, `KILOCODE_API_BASE_URL=${apiUrl}`);
  } else {
    content += `\nKILOCODE_API_BASE_URL=${apiUrl}\n`;
  }

  await Bun.write(devVarsPath, content);
  ui.success(`Set KILOCODE_API_BASE_URL=${apiUrl}`);
}
