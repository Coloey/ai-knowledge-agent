import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ArtifactProcessor } from '../src/artifacts/artifact.processor';
import { GENERATE_ARTIFACT_JOB } from '../src/queue/queue.constants';
import { ObjectStorageService } from '../src/storage/object-storage.service';

const generation = {
  artifact: {
    id: 'artifact_1',
    workspaceId: 'workspace_1',
    answerId: 'answer_1',
    title: 'Weekly report',
    status: 'queued',
    version: 1,
  },
  job: { id: 'artifact_job_1', version: 1, status: 'pending' },
};

describe('ArtifactProcessor', () => {
  it('moves a matching generation through processing to completed and stores only rendered output', async () => {
    const repository = artifactRepository(generation);
    const renderer = {
      render: vi.fn().mockResolvedValue({
        filename: 'weekly-report.md',
        contentType: 'text/markdown',
        body: Readable.from('generated report'),
      }),
    };
    const storage = {
      saveGenerated: vi.fn().mockResolvedValue({
        storageKey: 'private-key-not-in-job',
        size: 16,
        contentType: 'text/markdown',
      }),
    };
    const processor = new ArtifactProcessor(repository as never, renderer as never, storage as never);
    const job = queueJob();

    await processor.process(job as never);

    expect(repository.markProcessing).toHaveBeenCalledWith('artifact_1', 'artifact_job_1', 1);
    expect(renderer.render).toHaveBeenCalledWith(
      { answerId: 'answer_1', title: 'Weekly report' },
      expect.any(AbortSignal),
    );
    expect(storage.saveGenerated).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      artifactId: 'artifact_1',
      version: 1,
      filename: 'weekly-report.md',
      contentType: 'text/markdown',
      stream: expect.any(Readable),
    });
    expect(repository.completeGeneration).toHaveBeenCalledWith('artifact_1', 'artifact_job_1', 1, {
      storageKey: 'private-key-not-in-job',
      size: 16,
      mimeType: 'text/markdown',
    });
    expect(job.updateProgress).toHaveBeenNthCalledWith(1, 10);
    expect(job.updateProgress).toHaveBeenNthCalledWith(2, 100);
  });

  it('records a safe failed state and allows BullMQ to retry a processing failure', async () => {
    const repository = artifactRepository(generation);
    const renderer = { render: vi.fn().mockRejectedValue(new Error('renderer internals: prompt leaked')) };
    const storage = { saveGenerated: vi.fn() };
    const processor = new ArtifactProcessor(repository as never, renderer as never, storage as never);

    await expect(processor.process(queueJob() as never)).rejects.toThrow('renderer internals: prompt leaked');

    expect(repository.failGeneration).toHaveBeenCalledWith(
      'artifact_1',
      'artifact_job_1',
      1,
      'ARTIFACT_GENERATION_FAILED',
      'Artifact generation failed',
    );
  });

  it('records a safe failure when reporting initial progress fails', async () => {
    const repository = artifactRepository(generation);
    const processor = new ArtifactProcessor(
      repository as never,
      { render: vi.fn() } as never,
      { saveGenerated: vi.fn() } as never,
    );
    const job = queueJob();
    job.updateProgress.mockRejectedValueOnce(new Error('redis progress unavailable'));

    await expect(processor.process(job as never)).rejects.toThrow('redis progress unavailable');

    expect(repository.failGeneration).toHaveBeenCalledWith(
      'artifact_1',
      'artifact_job_1',
      1,
      'ARTIFACT_GENERATION_FAILED',
      'Artifact generation failed',
    );
    expect(repository.failGeneration).toHaveBeenCalledOnce();
  });

  it('completes a restart retry that regenerates a persisted same-version local artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-artifact-processor-'));
    try {
      const storage = localStorage(directory);
      await storage.saveGenerated({
        workspaceId: 'workspace_1',
        artifactId: 'artifact_1',
        version: 1,
        filename: 'weekly-report.md',
        contentType: 'text/markdown',
        stream: Readable.from([Buffer.from('written before process crash')]),
      });
      const repository = artifactRepository(generation);
      const processor = new ArtifactProcessor(
        repository as never,
        {
          render: vi.fn().mockResolvedValue({
            filename: 'weekly-report.md',
            contentType: 'text/markdown',
            body: Readable.from([Buffer.from('regenerated after restart')]),
          }),
        } as never,
        storage,
      );

      await processor.process(queueJob() as never);

      expect(await storage.readBuffer('workspace_1/artifacts/artifact_1/v1/weekly-report.md')).toEqual(
        Buffer.from('regenerated after restart'),
      );
      expect(repository.completeGeneration).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not render or overwrite state for a stale job version', async () => {
    const repository = artifactRepository({
      artifact: { ...generation.artifact, version: 2, status: 'processing' },
      job: generation.job,
    });
    const renderer = { render: vi.fn() };
    const storage = { saveGenerated: vi.fn() };
    const processor = new ArtifactProcessor(repository as never, renderer as never, storage as never);

    await processor.process(queueJob() as never);

    expect(repository.markProcessing).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.saveGenerated).not.toHaveBeenCalled();
    expect(repository.completeGeneration).not.toHaveBeenCalled();
    expect(repository.failGeneration).not.toHaveBeenCalled();
  });

  it('does not redo a completed matching generation after a worker restart', async () => {
    const repository = artifactRepository({
      artifact: { ...generation.artifact, status: 'completed' },
      job: { ...generation.job, status: 'completed' },
    });
    const renderer = { render: vi.fn() };
    const storage = { saveGenerated: vi.fn() };
    const processor = new ArtifactProcessor(repository as never, renderer as never, storage as never);

    await processor.process(queueJob() as never);

    expect(repository.markProcessing).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
    expect(storage.saveGenerated).not.toHaveBeenCalled();
    expect(repository.completeGeneration).not.toHaveBeenCalled();
  });
});

function artifactRepository(
  loaded: typeof generation | { artifact: Record<string, unknown>; job: Record<string, unknown> },
) {
  return {
    loadGeneration: vi.fn().mockResolvedValue(loaded),
    markProcessing: vi.fn().mockResolvedValue(true),
    completeGeneration: vi.fn().mockResolvedValue(true),
    failGeneration: vi.fn().mockResolvedValue(true),
  };
}

function queueJob() {
  return {
    name: GENERATE_ARTIFACT_JOB,
    data: { artifactId: 'artifact_1', jobId: 'artifact_job_1', version: 1 },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

function localStorage(directory: string): ObjectStorageService {
  return new ObjectStorageService({
    get: (key: string) =>
      ({
        STORAGE_BACKEND: 'local',
        LOCAL_STORAGE_DIR: directory,
        S3_ENDPOINT_URL: 'http://localhost:9000',
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'agent-files',
        S3_ACCESS_KEY: 'access',
        S3_SECRET_KEY: 'secret',
        S3_FORCE_PATH_STYLE: true,
        MAX_UPLOAD_BYTES: 1024,
      })[key],
  } as never);
}
