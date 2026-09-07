import { Readable } from 'node:stream';

import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ArtifactApplication } from '../src/artifacts/artifact.application';
import { MarkdownReportRenderer } from '../src/artifacts/markdown-report.renderer';

describe('ArtifactApplication', () => {
  it('returns a stable artifact reference and cancellation handle from a requested answer', async () => {
    const repository = {
      requestFromAnswer: vi.fn().mockResolvedValue({
        artifact: {
          id: 'artifact_1',
          kind: 'document',
          title: 'Weekly report',
          status: 'queued',
        },
      }),
    };
    const application = new ArtifactApplication(repository as never, {} as never, {} as never);

    const request = await application.requestFromAnswer({
      workspaceId: 'workspace_1',
      sessionId: 'session_1',
      answerId: 'answer_1',
      kind: 'document',
      title: 'Weekly report',
    });

    expect(request.artifact).toEqual({
      id: 'artifact_1',
      kind: 'document',
      title: 'Weekly report',
      status: 'queued',
    });
    await expect(request.cancel()).resolves.toBe(false);
    expect(repository.requestFromAnswer).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      sessionId: 'session_1',
      answerId: 'answer_1',
      kind: 'document',
      title: 'Weekly report',
    });
  });

  it('keeps a reused request cancellation handle inert', async () => {
    const repository = {
      requestFromAnswer: vi.fn().mockResolvedValue({
        artifact: { id: 'artifact_1', kind: 'document', title: 'Weekly report', status: 'queued' },
      }),
      cancelRequest: vi.fn(),
    };
    const application = new ArtifactApplication(repository as never, {} as never, {} as never);

    const request = await application.requestFromAnswer({
      workspaceId: 'workspace_1',
      sessionId: 'session_1',
      answerId: 'answer_1',
      kind: 'document',
      title: 'Weekly report',
    });

    await expect(request.cancel()).resolves.toBe(false);
    expect(repository.cancelRequest).not.toHaveBeenCalled();
  });

  it('cancels only the new pending artifact request associated with its handle', async () => {
    const repository = {
      requestFromAnswer: vi.fn().mockResolvedValue({
        artifact: { id: 'artifact_1', kind: 'document', title: 'Weekly report', status: 'queued' },
        cancellation: { artifactId: 'artifact_1', jobId: 'artifact_job_1', version: 1, deleteArtifact: true },
      }),
      cancelRequest: vi.fn().mockResolvedValue(true),
    };
    const application = new ArtifactApplication(repository as never, {} as never, {} as never);

    const request = await application.requestFromAnswer({
      workspaceId: 'workspace_1',
      sessionId: 'session_1',
      answerId: 'answer_1',
      kind: 'document',
      title: 'Weekly report',
    });

    await expect(request.cancel()).resolves.toBe(true);
    expect(repository.cancelRequest).toHaveBeenCalledWith({
      artifactId: 'artifact_1',
      jobId: 'artifact_job_1',
      version: 1,
      deleteArtifact: true,
    });
  });

  it('authorizes detail from the persisted Artifact workspace and returns only the public projection', async () => {
    const detail = artifactDetail();
    const repository = { findDetail: vi.fn().mockResolvedValue(detail) };
    const workspaces = { assertMember: vi.fn().mockResolvedValue({ role: 'member' }) };
    const application = new ArtifactApplication(repository as never, workspaces as never, {} as never);

    await expect(application.getAuthorized('user_1', 'artifact_1')).resolves.toEqual(detail);
    expect(workspaces.assertMember).toHaveBeenCalledWith('user_1', 'workspace_1');
    expect(repository.findDetail).toHaveBeenCalledWith('artifact_1');
    expect(detail).not.toHaveProperty('storageKey');
    expect(detail).not.toHaveProperty('jobId');
  });

  it('returns not found for a non-member and never loads storage metadata', async () => {
    const repository = {
      findDetail: vi.fn().mockResolvedValue(artifactDetail({ status: 'completed' })),
      findContent: vi.fn(),
    };
    const workspaces = { assertMember: vi.fn().mockRejectedValue(new ForbiddenException()) };
    const storage = { openStream: vi.fn() };
    const application = new ArtifactApplication(repository as never, workspaces as never, storage as never);

    await expect(application.openAuthorized('other_user', 'artifact_1')).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findContent).not.toHaveBeenCalled();
    expect(storage.openStream).not.toHaveBeenCalled();
  });

  it('rejects content until completed and streams completed content after authorization', async () => {
    const pendingRepository = { findDetail: vi.fn().mockResolvedValue(artifactDetail({ status: 'processing' })) };
    const workspaces = { assertMember: vi.fn().mockResolvedValue({ role: 'member' }) };
    const pending = new ArtifactApplication(pendingRepository as never, workspaces as never, {} as never);
    await expect(pending.openAuthorized('user_1', 'artifact_1')).rejects.toBeInstanceOf(ConflictException);

    const body = Readable.from(['report']);
    const repository = {
      findDetail: vi
        .fn()
        .mockResolvedValue(artifactDetail({ status: 'completed', mime_type: 'text/markdown', size: 6, progress: 100 })),
      findContent: vi.fn().mockResolvedValue({
        status: 'completed',
        storageKey: 'workspace_1/artifacts/artifact_1/v1/report.md',
        mimeType: 'text/markdown',
        size: 6,
      }),
    };
    const storage = { openStream: vi.fn().mockResolvedValue({ body, size: 6, contentType: 'text/markdown' }) };
    const application = new ArtifactApplication(repository as never, workspaces as never, storage as never);

    await expect(application.openAuthorized('user_1', 'artifact_1')).resolves.toMatchObject({
      body,
      size: 6,
      mimeType: 'text/markdown',
      inlineAllowed: true,
      filename: 'Weekly report.md',
    });
    expect(repository.findContent).toHaveBeenCalledWith('artifact_1', 'workspace_1');
    expect(storage.openStream).toHaveBeenCalledWith('workspace_1/artifacts/artifact_1/v1/report.md');
  });

  it('authorizes retry through the persisted workspace and returns the next queued version', async () => {
    const next = artifactDetail({ status: 'queued', version: 2, progress: 0 });
    const repository = {
      findDetail: vi.fn().mockResolvedValue(artifactDetail({ status: 'failed' })),
      retryFailed: vi.fn().mockResolvedValue(next),
    };
    const workspaces = { assertMember: vi.fn().mockResolvedValue({ role: 'member' }) };
    const application = new ArtifactApplication(repository as never, workspaces as never, {} as never);

    await expect(application.retryAuthorized('user_1', 'artifact_1')).resolves.toEqual(next);
    expect(workspaces.assertMember).toHaveBeenCalledWith('user_1', 'workspace_1');
    expect(repository.retryFailed).toHaveBeenCalledWith('artifact_1', 'workspace_1');
  });
});

describe('MarkdownReportRenderer', () => {
  it('rebuilds UTF-8 answer text, sanitizes the filename, and does not duplicate the result fallback', async () => {
    const repository = {
      answerEvents: vi.fn().mockResolvedValue([
        { type: 'data', contentJson: { text: '你好，' } },
        { type: 'data', contentJson: { text: '世界' } },
        { type: 'result', contentJson: { text: '你好，世界' } },
      ]),
    };
    const renderer = new MarkdownReportRenderer(repository as never);

    const rendered = await renderer.render(
      { answerId: 'answer_1', title: '../\r\n季度/报告' },
      new AbortController().signal,
    );

    expect(rendered.filename).toBe('季度-报告.md');
    expect(rendered.contentType).toBe('text/markdown');
    await expect(readableText(rendered.body)).resolves.toContain('你好，世界');
  });

  it('honors an already aborted render', async () => {
    const controller = new AbortController();
    controller.abort();
    const renderer = new MarkdownReportRenderer({ answerEvents: vi.fn() } as never);

    await expect(renderer.render({ answerId: 'answer_1', title: 'Report' }, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

async function readableText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as Readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function artifactDetail(
  overrides: Partial<{
    status: 'queued' | 'processing' | 'completed' | 'failed';
    mime_type: string;
    size: number;
    progress: number;
    version: number;
  }> = {},
) {
  return {
    id: 'artifact_1',
    kind: 'document' as const,
    title: 'Weekly report',
    status: 'queued' as const,
    workspace_id: 'workspace_1',
    session_id: 'session_1',
    answer_id: 'answer_1',
    progress: 0,
    version: 1,
    created_at: 1_000,
    updated_at: 2_000,
    ...overrides,
  };
}
