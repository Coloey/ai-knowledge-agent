import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ArtifactRepository } from '../src/artifacts/artifact.repository';
import { artifactJobs, artifacts, chatAnswers, outboxEvents } from '../src/database/schema';

describe('ArtifactRepository requestFromAnswer', () => {
  it('atomically reuses the first-version artifact and emits one minimal outbox request', async () => {
    const database = artifactDatabase({ workspaceId: 'workspace_1', sessionId: 'session_1' });
    const repository = new ArtifactRepository(database as never);
    const request = {
      workspaceId: 'workspace_1',
      sessionId: 'session_1',
      answerId: 'answer_1',
      kind: 'document' as const,
      title: 'Weekly report',
    };

    const first = await repository.requestFromAnswer(request);
    const replay = await repository.requestFromAnswer(request);

    expect(replay.artifact).toEqual(first.artifact);
    expect(replay.cancellation).toBeUndefined();
    expect(database.inserted.filter((entry) => entry.table === artifacts)).toHaveLength(2);
    expect(database.inserted.filter((entry) => entry.table === artifactJobs)).toHaveLength(2);
    const outbox = database.inserted.filter((entry) => entry.table === outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.values.payloadJson).toEqual({
      artifactId: first.artifact.id,
      jobId: expect.stringMatching(/^artifact_job_/),
      version: 1,
    });
    expect(Object.keys(outbox[0]?.values.payloadJson ?? {})).toEqual(['artifactId', 'jobId', 'version']);
  });

  it('rejects an answer from another workspace before writing an artifact', async () => {
    const database = artifactDatabase({ workspaceId: 'workspace_2', sessionId: 'session_1' });
    const repository = new ArtifactRepository(database as never);

    await expect(
      repository.requestFromAnswer({
        workspaceId: 'workspace_1',
        sessionId: 'session_1',
        answerId: 'answer_1',
        kind: 'document',
        title: 'Weekly report',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(database.inserted).toEqual([]);
  });

  it('removes only the unpublished pending job and its newly created queued artifact', async () => {
    const database = cancellationDatabase();
    const repository = new ArtifactRepository(database as never);

    await expect(
      repository.cancelRequest({ artifactId: 'artifact_1', jobId: 'artifact_job_1', version: 1, deleteArtifact: true }),
    ).resolves.toBe(true);
    expect(database.deleteAttempts).toEqual([outboxEvents, artifactJobs, artifacts]);
    expect(database.rolledBack).toBe(false);
  });

  it('leaves a reused request with no pending job intact', async () => {
    const database = cancellationDatabase({ pendingJob: false });
    const repository = new ArtifactRepository(database as never);

    await expect(
      repository.cancelRequest({ artifactId: 'artifact_1', jobId: 'artifact_job_1', version: 1, deleteArtifact: true }),
    ).resolves.toBe(false);
    expect(database.deleteAttempts).toEqual([]);
  });

  it('leaves a pending job with an already-published outbox intact', async () => {
    const database = cancellationDatabase({ publishedAt: new Date() });
    const repository = new ArtifactRepository(database as never);

    await expect(
      repository.cancelRequest({ artifactId: 'artifact_1', jobId: 'artifact_job_1', version: 1, deleteArtifact: true }),
    ).resolves.toBe(false);
    expect(database.deleteAttempts).toEqual([]);
  });

  it.each(['processing', 'completed'] as const)('does not delete a %s artifact', async (artifactStatus) => {
    const database = cancellationDatabase({ artifactStatus });
    const repository = new ArtifactRepository(database as never);

    await expect(
      repository.cancelRequest({ artifactId: 'artifact_1', jobId: 'artifact_job_1', version: 1, deleteArtifact: true }),
    ).resolves.toBe(false);
    expect(database.deleteAttempts).toEqual([]);
  });

  it('rolls back when a conditional delete loses a concurrent state change', async () => {
    const database = cancellationDatabase({ artifactDeleteRows: 0 });
    const repository = new ArtifactRepository(database as never);

    await expect(
      repository.cancelRequest({ artifactId: 'artifact_1', jobId: 'artifact_job_1', version: 1, deleteArtifact: true }),
    ).resolves.toBe(false);
    expect(database.deleteAttempts).toEqual([outboxEvents, artifactJobs, artifacts]);
    expect(database.rolledBack).toBe(true);
  });

  it('serializes parallel failed retries into exactly one next version, job, and outbox event', async () => {
    const database = retryDatabase();
    const repository = new ArtifactRepository(database as never);

    const results = await Promise.allSettled([
      repository.retryFailed('artifact_1', 'workspace_1'),
      repository.retryFailed('artifact_1', 'workspace_1'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: expect.any(ConflictException) });
    expect(database.artifact).toMatchObject({ status: 'queued', version: 2 });
    expect(database.inserted.filter((entry) => entry.table === artifactJobs)).toHaveLength(1);
    const outbox = database.inserted.filter((entry) => entry.table === outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.values.payloadJson).toEqual({
      artifactId: 'artifact_1',
      jobId: expect.stringMatching(/^artifact_job_/),
      version: 2,
    });
    expect(Object.keys(outbox[0]?.values.payloadJson ?? {})).toEqual(['artifactId', 'jobId', 'version']);
  });

  it('maps persisted internal diagnostics to the approved public Artifact error', async () => {
    const database = detailDatabase({
      id: 'artifact_1',
      workspaceId: 'workspace_1',
      sessionId: 'session_1',
      answerId: 'answer_1',
      kind: 'document',
      title: 'Weekly report',
      status: 'failed',
      mimeType: null,
      size: null,
      progress: 75,
      version: 1,
      errorCode: 'S3_PERMISSION_DENIED',
      errorMessage:
        'InternalError: bucket=private-artifacts storageKey=workspace_1/report.md job=artifact_job_7 queue=artifact-generation\n    at /srv/worker.ts:42:7',
      storageKey: 'workspace_1/report.md',
      bucket: 'private-artifacts',
      jobId: 'artifact_job_7',
      queueName: 'artifact-generation',
      createdAt: new Date(1_000),
      updatedAt: new Date(2_000),
    });
    const repository = new ArtifactRepository(database as never);

    const detail = await repository.findDetail('artifact_1');

    expect(detail).toMatchObject({
      status: 'failed',
      error_code: 'ARTIFACT_GENERATION_FAILED',
      error_message: 'Artifact generation failed',
    });
    expect(JSON.stringify(detail)).not.toMatch(
      /storageKey|bucket|job|queue|stack|internal|\/srv|S3_PERMISSION_DENIED/i,
    );
  });
});

function detailDatabase(row: Record<string, unknown>) {
  return {
    db: {
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: () => ({ limit: async () => [row] }),
          }),
        }),
      }),
    },
  };
}

function artifactDatabase(context: { workspaceId: string; sessionId: string }) {
  const inserted: Array<{ table: object; values: Record<string, unknown> }> = [];
  let artifact: Record<string, unknown> | undefined;
  let job: Record<string, unknown> | undefined;
  const tx = {
    select: () => ({
      from: (table: object) => {
        if (table === chatAnswers) {
          return {
            innerJoin: () => ({ where: () => ({ limit: async () => [{ answerId: 'answer_1', ...context }] }) }),
          };
        }
        if (table === artifacts) return { where: () => ({ limit: async () => (artifact ? [artifact] : []) }) };
        return { where: () => ({ orderBy: async () => [] }) };
      },
    }),
    insert: (table: object) => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ table, values });
        if (table === outboxEvents) return Promise.resolve();
        return {
          onConflictDoNothing: () => ({
            returning: async () => {
              if (table === artifacts) {
                if (artifact) return [];
                artifact = { ...values };
                return [artifact];
              }
              if (table === artifactJobs) {
                if (job) return [];
                job = { ...values };
                return [job];
              }
              return [];
            },
          }),
        };
      },
    }),
  };
  return {
    db: { transaction: async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx) },
    inserted,
  };
}

function cancellationDatabase({
  pendingJob = true,
  publishedAt,
  artifactStatus = 'queued',
  outboxDeleteRows = 1,
  jobDeleteRows = 1,
  artifactDeleteRows = 1,
}: {
  pendingJob?: boolean;
  publishedAt?: Date;
  artifactStatus?: 'queued' | 'processing' | 'completed';
  outboxDeleteRows?: number;
  jobDeleteRows?: number;
  artifactDeleteRows?: number;
} = {}) {
  const deleteAttempts: object[] = [];
  let rolledBack = false;
  const rows = {
    job: { id: 'artifact_job_1', status: pendingJob ? 'pending' : 'processing' },
    outbox: { id: 'outbox_1', publishedAt: publishedAt ?? null },
    artifact: { id: 'artifact_1', status: artifactStatus },
  };
  const tx = {
    select: () => ({
      from: (table: object) => ({
        where: () => ({
          limit: () => ({
            for: async () => {
              if (table === artifactJobs) return [rows.job];
              if (table === outboxEvents) return [rows.outbox];
              if (table === artifacts) return [rows.artifact];
              return [];
            },
          }),
        }),
      }),
    }),
    delete: (table: object) => ({
      where: () => {
        deleteAttempts.push(table);
        const count =
          table === outboxEvents ? outboxDeleteRows : table === artifactJobs ? jobDeleteRows : artifactDeleteRows;
        return { returning: async () => (count ? [{ id: 'deleted_1' }] : []) };
      },
    }),
  };
  return {
    db: {
      transaction: async (operation: (transaction: typeof tx) => Promise<unknown>) => {
        try {
          return await operation(tx);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      },
    },
    deleteAttempts,
    get rolledBack() {
      return rolledBack;
    },
  };
}

function retryDatabase() {
  const inserted: Array<{ table: object; values: Record<string, unknown> }> = [];
  const artifact: Record<string, unknown> = {
    id: 'artifact_1',
    workspaceId: 'workspace_1',
    sessionId: 'session_1',
    answerId: 'answer_1',
    kind: 'document',
    title: 'Weekly report',
    status: 'failed',
    mimeType: null,
    size: null,
    version: 1,
    errorCode: 'ARTIFACT_GENERATION_FAILED',
    errorMessage: 'Artifact generation failed',
    createdAt: new Date(1_000),
    updatedAt: new Date(2_000),
  };
  let transactionTail = Promise.resolve();
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ for: async () => [{ ...artifact }] }),
        }),
      }),
    }),
    update: (table: object) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (table !== artifacts || artifact.status !== 'failed') return [];
            Object.assign(artifact, values);
            return [{ ...artifact }];
          },
        }),
      }),
    }),
    insert: (table: object) => ({
      values: async (values: Record<string, unknown>) => {
        inserted.push({ table, values });
      },
    }),
  };
  return {
    db: {
      transaction: <T>(operation: (transaction: typeof tx) => Promise<T>): Promise<T> => {
        const result = transactionTail.then(() => operation(tx));
        transactionTail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    },
    artifact,
    inserted,
  };
}
