export const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
export const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
export const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

export function header(text: string) {
  console.log(`\n${bold(cyan(`==> ${text}`))}`);
}

export function success(text: string) {
  console.log(green(`  ✓ ${text}`));
}

export function warn(text: string) {
  console.log(yellow(`  ⚠ ${text}`));
}

export function error(text: string) {
  console.error(red(`  ✗ ${text}`));
}

export function table(rows: [string, string][]) {
  const maxKey = Math.max(...rows.map(([k]) => k.length));
  for (const [key, val] of rows) {
    console.log(`  ${key.padEnd(maxKey)}  ${dim(val)}`);
  }
}
