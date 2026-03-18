import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getTownStub(name = 'test-town') {
  const id = env.TOWN.idFromName(name);
  return env.TOWN.get(id);
}

describe('Review failure paths — convoy progress and source bead recovery', () => {
  let town: ReturnType<typeof getTownStub>;

  beforeEach(() => {
    town = getTownStub(`review-failure-${crypto.randomUUID()}`);
  });

  async function setupConvoyWithMR() {
    await town.addRig({
      rigId: 'rig-1',
      name: 'main-rig',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });

    const result = await town.slingConvoy({
      rigId: 'rig-1',
      convoyTitle: 'Review Failure Test',
      tasks: [{ title: 'Task 1' }],
    });

    const beadId = result.beads[0].bead.bead_id;
    const agentId = result.beads[0].agent.id;

    // Simulate agent completing work — creates an MR bead in review queue
    await town.agentDone(agentId, {
      branch: 'gt/polecat/test-branch',
      summary: 'Completed task',
    });

    // Source bead should now be in_review (waiting for refinery)
    const sourceBead = await town.getBeadAsync(beadId);
    expect(sourceBead?.status).toBe('in_review');

    // Find the MR bead
    const allBeads = await town.listBeads({ type: 'merge_request' });
    const mrBead = allBeads.find(b => b.metadata?.source_bead_id === beadId);
    expect(mrBead).toBeTruthy();

    return { result, beadId, agentId, mrBeadId: mrBead!.bead_id, convoyId: result.convoy.id };
  }

  // ── completeReviewWithResult properly updates convoy progress ───────

  describe('completeReviewWithResult on MR failure', () => {
    it('should return source bead to in_progress when MR bead fails', async () => {
      const { beadId, mrBeadId } = await setupConvoyWithMR();

      // Fail the review via completeReviewWithResult (the fixed path)
      await town.completeReviewWithResult({
        entry_id: mrBeadId,
        status: 'failed',
        message: 'Refinery container failed to start',
      });

      // MR bead should be failed
      const mrBead = await town.getBeadAsync(mrBeadId);
      expect(mrBead?.status).toBe('failed');

      // Source bead should be returned to in_progress (not stuck in in_review)
      const sourceBead = await town.getBeadAsync(beadId);
      expect(sourceBead?.status).toBe('in_progress');
    });

    it('should update convoy progress when MR bead is merged', async () => {
      const { beadId, mrBeadId, convoyId } = await setupConvoyWithMR();

      // Complete the review successfully
      await town.completeReviewWithResult({
        entry_id: mrBeadId,
        status: 'merged',
        message: 'Merged by refinery',
      });

      // Source bead should be closed
      const sourceBead = await town.getBeadAsync(beadId);
      expect(sourceBead?.status).toBe('closed');

      // MR bead should be closed
      const mrBead = await town.getBeadAsync(mrBeadId);
      expect(mrBead?.status).toBe('closed');

      // Convoy progress should reflect the closed bead
      const convoyStatus = await town.getConvoyStatus(convoyId);
      expect(convoyStatus?.closed_beads).toBe(1);
    });
  });

  // ── Multi-bead convoy: failed MR doesn't stall the convoy ──────────

  describe('convoy progress with mixed outcomes', () => {
    it('should not stall convoy when one MR fails and another merges', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Two-Task Convoy',
        tasks: [{ title: 'Task 1' }, { title: 'Task 2' }],
      });

      const bead0Id = result.beads[0].bead.bead_id;
      const agent0Id = result.beads[0].agent.id;
      const bead1Id = result.beads[1].bead.bead_id;
      const agent1Id = result.beads[1].agent.id;

      // Both agents complete work
      await town.agentDone(agent0Id, {
        branch: 'gt/polecat/task-1',
        summary: 'Task 1 done',
      });
      await town.agentDone(agent1Id, {
        branch: 'gt/polecat/task-2',
        summary: 'Task 2 done',
      });

      // Find MR beads
      const mrBeads = await town.listBeads({ type: 'merge_request' });
      const mr0 = mrBeads.find(b => b.metadata?.source_bead_id === bead0Id);
      const mr1 = mrBeads.find(b => b.metadata?.source_bead_id === bead1Id);
      expect(mr0).toBeTruthy();
      expect(mr1).toBeTruthy();

      // Fail MR for task 1 via completeReviewWithResult
      await town.completeReviewWithResult({
        entry_id: mr0!.bead_id,
        status: 'failed',
        message: 'Review failed',
      });

      // Source bead 0 should be back to in_progress (ready for rework)
      const source0 = await town.getBeadAsync(bead0Id);
      expect(source0?.status).toBe('in_progress');

      // Merge MR for task 2
      await town.completeReviewWithResult({
        entry_id: mr1!.bead_id,
        status: 'merged',
        message: 'Merged',
      });

      // Source bead 1 should be closed
      const source1 = await town.getBeadAsync(bead1Id);
      expect(source1?.status).toBe('closed');

      // Convoy should show 1 closed bead (task 2 merged; task 1 is in_progress
      // awaiting rework, its MR is failed but the source isn't terminal yet)
      const convoyStatus = await town.getConvoyStatus(result.convoy.id);
      expect(convoyStatus?.closed_beads).toBe(1);
    });
  });

  // ── Direct completeReview leaves source bead orphaned (regression) ─

  describe('completeReview bypass (regression guard)', () => {
    it('should leave source bead stuck in in_review when completeReview is called directly', async () => {
      const { beadId, mrBeadId } = await setupConvoyWithMR();

      // Call completeReview directly (the OLD broken path) —
      // this is the raw SQL update that bypasses lifecycle events.
      // We use this to verify the regression scenario.
      await town.completeReview(mrBeadId, 'failed');

      // MR bead should be failed
      const mrBead = await town.getBeadAsync(mrBeadId);
      expect(mrBead?.status).toBe('failed');

      // Source bead is STILL in_review — this is the bug this PR fixes
      // in processReviewQueue. The direct completeReview call doesn't
      // return the source bead to in_progress.
      const sourceBead = await town.getBeadAsync(beadId);
      expect(sourceBead?.status).toBe('in_review');
    });
  });

  // ── Source bead in_review after agentDone ──────────────────────────

  describe('agentDone transitions source bead to in_review', () => {
    it('should set source bead to in_review after polecat calls agentDone', async () => {
      await town.addRig({
        rigId: 'rig-1',
        name: 'main-rig',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Agent Done Test',
        tasks: [{ title: 'Single Task' }],
      });

      const beadId = result.beads[0].bead.bead_id;
      const agentId = result.beads[0].agent.id;

      await town.agentDone(agentId, {
        branch: 'gt/polecat/test',
        summary: 'Done',
      });

      const bead = await town.getBeadAsync(beadId);
      expect(bead?.status).toBe('in_review');

      // An MR bead should have been created
      const mrBeads = await town.listBeads({ type: 'merge_request' });
      expect(mrBeads.length).toBeGreaterThan(0);
      expect(mrBeads.some(b => b.metadata?.source_bead_id === beadId)).toBe(true);
    });
  });
});
