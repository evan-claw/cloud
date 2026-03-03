import type { O11YBinding } from './o11y-binding';

export type Env = Omit<Cloudflare.Env, 'O11Y'> & { O11Y: O11YBinding };
