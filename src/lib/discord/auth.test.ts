import { beforeEach, describe, expect, test } from '@jest/globals';
import { getDiscordAuthTokenForRequester } from '@/lib/discord/auth';
import { addUserToOrganization, createOrganization } from '@/lib/organizations/organizations';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';

describe('getDiscordAuthTokenForRequester', () => {
  beforeEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_memberships);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilocode_users);
  });

  test('returns member auth token for org-owned integration when Discord user is linked', async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const organization = await createOrganization('Discord Auth Test Org', owner.id);
    await addUserToOrganization(organization.id, member.id, 'member');

    const result = await getDiscordAuthTokenForRequester(
      { type: 'org', id: organization.id },
      {
        metadata: {
          authorized_discord_users: {
            'discord-member': member.id,
          },
        },
        discordUserId: 'discord-member',
      }
    );

    expect('error' in result).toBe(false);
    if ('error' in result) {
      return;
    }

    expect(result.userId).toBe(member.id);
    expect(result.authToken.length).toBeGreaterThan(20);
  });

  test('rejects org request when linked Discord user is not an organization member', async () => {
    const owner = await insertTestUser();
    const outsider = await insertTestUser();
    const organization = await createOrganization('Discord Auth Test Org', owner.id);

    const result = await getDiscordAuthTokenForRequester(
      { type: 'org', id: organization.id },
      {
        metadata: {
          authorized_discord_users: {
            'discord-outsider': outsider.id,
          },
        },
        discordUserId: 'discord-outsider',
      }
    );

    expect(result).toEqual({
      error: 'This Discord user is not a member of the organization that owns this integration.',
      errorCode: 'not_org_member',
    });
  });

  test('rejects org request when Discord user has no link', async () => {
    const owner = await insertTestUser();
    const organization = await createOrganization('Discord Auth Test Org', owner.id);

    const result = await getDiscordAuthTokenForRequester(
      { type: 'org', id: organization.id },
      {
        metadata: {
          authorized_discord_users: {
            'discord-owner': owner.id,
          },
        },
        discordUserId: 'discord-unknown',
      }
    );

    expect(result).toEqual({
      error:
        'This Discord user is not linked to a Kilo member for this integration. Open Kilo integration settings and click "Link My Discord Account" using this Discord user.',
      errorCode: 'unlinked_requester',
    });
  });

  test('allows user-owned integration when requester maps to the owner', async () => {
    const user = await insertTestUser();

    const result = await getDiscordAuthTokenForRequester(
      { type: 'user', id: user.id },
      {
        metadata: {
          authorized_discord_users: {
            'discord-owner': user.id,
          },
        },
        discordUserId: 'discord-owner',
      }
    );

    expect('error' in result).toBe(false);
    if ('error' in result) {
      return;
    }

    expect(result.userId).toBe(user.id);
    expect(result.authToken.length).toBeGreaterThan(20);
  });

  test('rejects user-owned integration when requester maps to another user', async () => {
    const owner = await insertTestUser();
    const otherUser = await insertTestUser();

    const result = await getDiscordAuthTokenForRequester(
      { type: 'user', id: owner.id },
      {
        metadata: {
          authorized_discord_users: {
            'discord-other': otherUser.id,
          },
        },
        discordUserId: 'discord-other',
      }
    );

    expect(result).toEqual({
      error: 'Only the owner of this user-level integration can use it.',
      errorCode: 'not_user_owner',
    });
  });
});
