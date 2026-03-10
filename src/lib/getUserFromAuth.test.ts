import { describe, test, expect, beforeEach } from '@jest/globals';
import { defineTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';

// ---------------------------------------------------------------------------
// Mocks — jest.mock calls are hoisted, so reference via requireMock later
// ---------------------------------------------------------------------------

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
}));

jest.mock('next/headers', () => ({
  headers: jest.fn(),
  cookies: jest.fn().mockResolvedValue({ get: jest.fn() }),
}));

jest.mock('next-auth', () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

// Stub out auth providers — they run code at import time
jest.mock('next-auth/providers/google', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('next-auth/providers/github', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('next-auth/providers/gitlab', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('next-auth/providers/linkedin', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('next-auth/providers/workos', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('next-auth/providers/credentials', () => ({ __esModule: true, default: jest.fn() }));

jest.mock('./user', () => ({
  findUserById: jest.fn(),
  createOrUpdateUser: jest.fn(),
  findAndSyncExistingUser: jest.fn(),
  linkAccountToExistingUser: jest.fn(),
}));

jest.mock('@/lib/drizzle', () => ({
  db: {},
  readDb: {},
}));

jest.mock('./tokens', () => ({
  validateAuthorizationHeader: jest.fn(),
  JWT_TOKEN_VERSION: 3,
}));

jest.mock('@/lib/posthog', () => ({
  __esModule: true,
  default: () => ({ capture: jest.fn(), shutdown: jest.fn() }),
}));

jest.mock('@/lib/organizations/organizations', () => ({
  doesOrgWithSSODomainExist: jest.fn(),
  getSingleUserOrganization: jest.fn(),
  isOrganizationMember: jest.fn(),
}));

jest.mock('@/lib/account-linking-session', () => ({
  getAccountLinkingSession: jest.fn(),
}));

jest.mock('@/lib/sso-user', () => ({
  processSSOUserLogin: jest.fn(),
}));

jest.mock('@/lib/auth/magic-link-tokens', () => ({
  verifyAndConsumeMagicLinkToken: jest.fn(),
}));

jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
}));

jest.mock('@/lib/organizations/trial-utils', () => ({
  isOrganizationHardLocked: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Import module under test and resolve mock handles
// ---------------------------------------------------------------------------

import { getUserFromAuth } from './user.server';
import { setUser } from '@sentry/nextjs';
import { headers } from 'next/headers';
import { validateAuthorizationHeader } from './tokens';
import { findUserById } from './user';
import { getServerSession } from 'next-auth';

const mockSetUser = jest.mocked(setUser);
const mockHeaders = jest.mocked(headers);
const mockValidateAuth = jest.mocked(validateAuthorizationHeader);
const mockFindUserById = jest.mocked(findUserById);
const mockGetServerSession = jest.mocked(getServerSession);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeHeaders(map: Record<string, string>) {
  const entries = Object.entries(map).map(([k, v]) => [k.toLowerCase(), v] as [string, string]);
  const store = new Map(entries);
  return {
    get: (name: string) => store.get(name.toLowerCase()) ?? null,
    entries: () => store.entries(),
  } as unknown as Awaited<ReturnType<typeof headers>>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getUserFromAuth — Sentry user attribution', () => {
  let testUser: User;

  beforeEach(() => {
    jest.clearAllMocks();
    testUser = defineTestUser({
      id: 'user-abc-123',
      google_user_email: 'jane@example.com',
    });
  });

  test('sets Sentry user on successful JWT authentication', async () => {
    mockHeaders.mockResolvedValue(fakeHeaders({ authorization: 'Bearer valid-token' }));

    mockValidateAuth.mockReturnValue({
      kiloUserId: testUser.id,
      apiTokenPepper: testUser.api_token_pepper,
    } as ReturnType<typeof validateAuthorizationHeader>);

    mockFindUserById.mockResolvedValue(testUser);

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.user).toEqual(testUser);
    expect(result.authFailedResponse).toBeNull();

    expect(mockSetUser).toHaveBeenCalledTimes(1);
    expect(mockSetUser).toHaveBeenCalledWith({
      id: 'user-abc-123',
      email: 'jane@example.com',
      ip_address: '{{auto}}',
    });
  });

  test('does not set Sentry user when authorization header is invalid', async () => {
    mockHeaders.mockResolvedValue(fakeHeaders({ authorization: 'Bearer bad-token' }));

    mockValidateAuth.mockReturnValue({
      error: 'Invalid token',
    } as ReturnType<typeof validateAuthorizationHeader>);

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.user).toBeNull();
    expect(mockSetUser).not.toHaveBeenCalled();
  });

  test('does not set Sentry user when user is blocked', async () => {
    const blockedUser = defineTestUser({
      id: 'blocked-user',
      google_user_email: 'blocked@example.com',
      blocked_reason: 'abuse',
    });

    mockHeaders.mockResolvedValue(fakeHeaders({ authorization: 'Bearer valid-token' }));

    mockValidateAuth.mockReturnValue({
      kiloUserId: blockedUser.id,
      apiTokenPepper: blockedUser.api_token_pepper,
    } as ReturnType<typeof validateAuthorizationHeader>);

    mockFindUserById.mockResolvedValue(blockedUser);

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.user).toBeNull();
    expect(result.authFailedResponse).not.toBeNull();
    expect(mockSetUser).not.toHaveBeenCalled();
  });

  test('does not set Sentry user when user is not found', async () => {
    mockHeaders.mockResolvedValue(fakeHeaders({ authorization: 'Bearer valid-token' }));

    mockValidateAuth.mockReturnValue({
      kiloUserId: 'nonexistent-user',
      apiTokenPepper: undefined,
    } as ReturnType<typeof validateAuthorizationHeader>);

    mockFindUserById.mockResolvedValue(undefined);

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.user).toBeNull();
    expect(mockSetUser).not.toHaveBeenCalled();
  });

  test('does not set Sentry user when non-admin requests admin-only route', async () => {
    mockHeaders.mockResolvedValue(fakeHeaders({ authorization: 'Bearer valid-token' }));

    mockValidateAuth.mockReturnValue({
      kiloUserId: testUser.id,
      apiTokenPepper: testUser.api_token_pepper,
    } as ReturnType<typeof validateAuthorizationHeader>);

    mockFindUserById.mockResolvedValue(testUser); // is_admin: false by default

    const result = await getUserFromAuth({ adminOnly: true });

    expect(result.user).toBeNull();
    expect(mockSetUser).not.toHaveBeenCalled();
  });

  test('does not set Sentry user when no auth is present', async () => {
    mockHeaders.mockResolvedValue(fakeHeaders({}));
    mockGetServerSession.mockResolvedValue(null);

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.user).toBeNull();
    expect(mockSetUser).not.toHaveBeenCalled();
  });
});
