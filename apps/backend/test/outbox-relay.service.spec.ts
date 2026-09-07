import { describe, expect, it, vi } from 'vitest';

import { OutboxRelayService } from '../src/library/outbox-relay.service';
import {
  ARTIFACT_GENERATION_QUEUE,
  GENERATE_ARTIFACT_JOB,
  LIBRARY_PARSE_QUEUE,
  PARSE_LIBRARY_FILE_JOB,
} from '../src/queue/queue.constants';

describe('OutboxRelayService', () => {
  it('maps artifact requests to the versioned artifact job without carrying generated content', async () => {
    const event = {
      id: 'outbox_1',
      eventType: 'artifact.generation.requested',
      payloadJson: { artifactId: 'artifact_1', jobId: 'artifact_job_1', version: 2 },
      attempts: 0,
    };
    const { database, updates } = outboxDatabase([event]);
    const libraryQueue = { add: vi.fn() };
    const artifactQueue = { add: vi.fn() };
    const relay = new OutboxRelayService(database as never, libraryQueue as never, artifactQueue as never);

    await relay.dispatch();

    expect(artifactQueue.add).toHaveBeenCalledWith(
      GENERATE_ARTIFACT_JOB,
      { artifactId: 'artifact_1', jobId: 'artifact_job_1', version: 2 },
      { jobId: 'artifact:artifact_1:v2' },
    );
    expect(libraryQueue.add).not.toHaveBeenCalled();
    expect(updates).toEqual([expect.objectContaining({ publishedAt: expect.any(Date), lastError: '' })]);
  });

  it('uses a deterministic BullMQ ID when an artifact event is dispatched again', async () => {
    const event = {
      id: 'outbox_1',
      eventType: 'artifact.generation.requested',
      payloadJson: { artifactId: 'artifact_1', jobId: 'artifact_job_1', version: 2 },
      attempts: 0,
    };
    const { database } = outboxDatabase([event]);
    const artifactQueue = { add: vi.fn() };
    const relay = new OutboxRelayService(database as never, { add: vi.fn() } as never, artifactQueue as never);

    await relay.dispatch();
    await relay.dispatch();

    expect(artifactQueue.add).toHaveBeenNthCalledWith(
      1,
      GENERATE_ARTIFACT_JOB,
      { artifactId: 'artifact_1', jobId: 'artifact_job_1', version: 2 },
      { jobId: 'artifact:artifact_1:v2' },
    );
    expect(artifactQueue.add).toHaveBeenNthCalledWith(
      2,
      GENERATE_ARTIFACT_JOB,
      { artifactId: 'artifact_1', jobId: 'artifact_job_1', version: 2 },
      { jobId: 'artifact:artifact_1:v2' },
    );
  });

  it('keeps existing library dispatch behavior in the same polling owner', async () => {
    const event = {
      id: 'outbox_2',
      eventType: 'library.file.uploaded',
      payloadJson: { fileId: 'file_1' },
      attempts: 0,
    };
    const { database } = outboxDatabase([event]);
    const libraryQueue = { add: vi.fn() };
    const artifactQueue = { add: vi.fn() };
    const relay = new OutboxRelayService(database as never, libraryQueue as never, artifactQueue as never);

    await relay.dispatch();

    expect(libraryQueue.add).toHaveBeenCalledWith(
      PARSE_LIBRARY_FILE_JOB,
      { fileId: 'file_1' },
      { jobId: 'parse-file_1' },
    );
    expect(artifactQueue.add).not.toHaveBeenCalled();
    expect(LIBRARY_PARSE_QUEUE).toBe('library-parse');
    expect(ARTIFACT_GENERATION_QUEUE).toBe('artifact-generation');
  });
});

function outboxDatabase(events: Array<Record<string, unknown>>) {
  const updates: Array<Record<string, unknown>> = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({ for: async () => events }),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: async () => undefined };
      },
    }),
  };
  return {
    database: { db: { transaction: async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx) } },
    updates,
  };
}
