// Port of src/lib/anonymous/anonymous-user.ts + ip-rate-limiter.ts

export type AnonymousUserContext = {
  isAnonymous: true;
  ipAddress: string;
  // Synthetic user-like properties for compatibility with the rest of the chain.
  id: string; // 'anon:{ipAddress}'
  microdollars_used: number;
  is_admin: false;
};

export function createAnonymousContext(ipAddress: string): AnonymousUserContext {
  return {
    isAnonymous: true,
    ipAddress,
    id: `anon:${ipAddress}`,
    microdollars_used: 0,
    is_admin: false,
  };
}

export function isAnonymousContext(user: unknown): user is AnonymousUserContext {
  return (
    typeof user === 'object' && user !== null && 'isAnonymous' in user && user.isAnonymous === true
  );
}
