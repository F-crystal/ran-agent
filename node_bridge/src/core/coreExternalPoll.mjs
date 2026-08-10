import { coreError } from './coreErrors.mjs';

export function createCoreExternalPollService({ core } = {}) {
  if (!core?.writer?.write || !core?.reader?.pendingExternalPollProjections) {
    throw coreError('CORE_EXTERNAL_POLL_DEPENDENCY_INVALID', 'Core writer is required');
  }
  async function completeProjection(row) {
    const cursor = core.reader.projectorCursor(row.projector_id, row.target_scope);
    const outbox = core.reader.projectionOutbox(row.projection_outbox_id);
    if (outbox?.state === 'completed') return outbox;
    if (!cursor || !outbox || !['pending', 'failed'].includes(outbox.state)) return null;
    const updatedAt = new Date().toISOString();
    return core.writer.write((tx) => {
      const claim = tx.projections.claim({
        cursorId: cursor.projector_cursor_id, outboxId: outbox.projection_outbox_id,
        expectedCursorRevision: Number(cursor.revision), expectedCursorFence: Number(cursor.fence_token),
        expectedOutboxRevision: Number(outbox.revision), leaseOwner: 'core-external-attention-projector',
        leaseUntil: new Date(Date.now() + 60_000).toISOString(),
        rotationOperationKey: `external-attention:complete:${outbox.projection_outbox_id}`,
        updatedAt,
      });
      if (!claim) return null;
      const committed = tx.projections.commitCursor({
        cursorId: cursor.projector_cursor_id, outboxId: outbox.projection_outbox_id,
        expectedCursorRevision: Number(claim.cursor.revision),
        expectedOutboxRevision: Number(claim.outbox.revision),
        fenceToken: Number(claim.cursor.fence_token), leaseOwner: 'core-external-attention-projector',
        updatedAt,
      });
      if (!committed) throw coreError('CORE_EXTERNAL_PROJECTION_STALE', 'external fact projection completion became stale');
      return committed;
    });
  }
  return Object.freeze({
    assertAuthority: (input) => core.writer.write((tx) => tx.externalPoll.assertAuthority(input)),
    recordFact: (input) => core.writer.write((tx) => tx.externalPoll.recordFact(input)),
    pendingProjections: (limit) => core.reader.pendingExternalPollProjections(limit),
    completeProjection,
    factCountForWorkRun: (workRunId) => core.reader.externalPollFactCountForWorkRun(workRunId),
  });
}
