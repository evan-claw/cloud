import { db } from '@/lib/drizzle';
import { cloud_agent_code_reviews, kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import {
  createCodeReview,
  updateCodeReviewStatus,
  findPreviousCompletedReview,
  findPreviousCompletedReviewSession,
} from './code-reviews';

const REPO = `test-org/session-continuation-${Date.now()}`;

describe('findPreviousCompletedReviewSession', () => {
  let testUser: User;
  const createdReviewIds: string[] = [];

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  afterAll(async () => {
    // Clean up reviews then user
    for (const id of createdReviewIds) {
      await db
        .delete(cloud_agent_code_reviews)
        .where(eq(cloud_agent_code_reviews.id, id));
    }
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  async function createReview(headSha: string) {
    const id = await createCodeReview({
      owner: { type: 'user', id: testUser.id, userId: testUser.id },
      repoFullName: REPO,
      prNumber: 42,
      prUrl: `https://github.com/${REPO}/pull/42`,
      prTitle: 'test PR',
      prAuthor: 'octocat',
      baseRef: 'main',
      headRef: 'feature/test',
      headSha,
    });
    createdReviewIds.push(id);
    return id;
  }

  it('returns null when no previous completed review exists', async () => {
    const result = await findPreviousCompletedReviewSession(REPO, 42, 'abc123');
    expect(result).toBeNull();
  });

  it('returns null when previous review is completed but has no session_id', async () => {
    const id = await createReview('sha-no-session');
    await updateCodeReviewStatus(id, 'completed');

    const result = await findPreviousCompletedReviewSession(REPO, 42, 'other-sha');
    expect(result).toBeNull();
  });

  it('returns session_id and head_sha for a completed review with session_id', async () => {
    const id = await createReview('sha-with-session');
    await updateCodeReviewStatus(id, 'completed', {
      sessionId: 'agent_test123',
    });

    const result = await findPreviousCompletedReviewSession(REPO, 42, 'other-sha');
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('agent_test123');
    expect(result!.head_sha).toBe('sha-with-session');
  });

  it('excludes the current SHA', async () => {
    const result = await findPreviousCompletedReviewSession(
      REPO,
      42,
      'sha-with-session'
    );
    // Should not find itself — only reviews with a different SHA
    // The "sha-no-session" review has no session_id, so only "sha-with-session" would match
    // but it's excluded by excludeSha
    expect(result).toBeNull();
  });

  it('returns the most recent completed review with session_id', async () => {
    const id = await createReview('sha-newer');
    await updateCodeReviewStatus(id, 'completed', {
      sessionId: 'agent_newer',
    });

    const result = await findPreviousCompletedReviewSession(REPO, 42, 'other-sha');
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('agent_newer');
    expect(result!.head_sha).toBe('sha-newer');
  });

  it('ignores non-completed reviews with session_id', async () => {
    const id = await createReview('sha-running');
    await updateCodeReviewStatus(id, 'running', {
      sessionId: 'agent_running',
    });

    // Should still return the most recent *completed* one
    const result = await findPreviousCompletedReviewSession(REPO, 42, 'other-sha');
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('agent_newer');
  });

  it('is consistent with findPreviousCompletedReview on head_sha', async () => {
    const sessionResult = await findPreviousCompletedReviewSession(
      REPO,
      42,
      'other-sha'
    );
    const shaResult = await findPreviousCompletedReview(REPO, 42, 'other-sha');

    // Both should find a completed review (sessionResult is more restrictive)
    expect(shaResult).not.toBeNull();
    expect(sessionResult).not.toBeNull();
    // The head_sha from the session query should also appear in the sha-only query
    expect(sessionResult!.head_sha).toBe(shaResult!.head_sha);
  });
});
