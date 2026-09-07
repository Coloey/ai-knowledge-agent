import { Readable } from 'node:stream';

import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';

import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { ArtifactController, contentDisposition } from '../src/artifacts/artifact.controller';

describe('ArtifactController', () => {
  it('requires JWT authentication for every Artifact route', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ArtifactController)).toContain(JwtAuthGuard);
  });

  it('wraps public detail and retry responses without exposing storage internals', async () => {
    const detail = {
      id: 'artifact_1',
      kind: 'document',
      title: 'Report',
      status: 'queued',
      workspace_id: 'workspace_1',
      session_id: 'session_1',
      answer_id: 'answer_1',
      progress: 0,
      version: 2,
      created_at: 1,
      updated_at: 2,
    };
    const artifacts = {
      getAuthorized: vi.fn().mockResolvedValue(detail),
      retryAuthorized: vi.fn().mockResolvedValue(detail),
    };
    const controller = new ArtifactController(artifacts as never);

    await expect(controller.detail(user(), 'artifact_1')).resolves.toEqual({ code: 0, data: detail, msg: 'ok' });
    await expect(controller.retry(user(), 'artifact_1')).resolves.toEqual({ code: 0, data: detail, msg: 'ok' });
    expect(JSON.stringify(detail)).not.toMatch(/storage|bucket|job/i);
  });

  it('streams content with safe private response headers and forces unsafe MIME to attachment', async () => {
    const body = Readable.from(['hello']);
    const artifacts = {
      openAuthorized: vi.fn().mockResolvedValue({
        body,
        filename: '../Quarterly\r\nReport.html',
        mimeType: 'application/octet-stream',
        size: 5,
        inlineAllowed: false,
      }),
    };
    const headers: Record<string, string> = {};
    const reply = {
      headers: vi.fn((next: Record<string, string>) => {
        Object.assign(headers, next);
        return reply;
      }),
      send: vi.fn(),
    };
    const controller = new ArtifactController(artifacts as never);

    await controller.content(user(), 'artifact_1', { disposition: 'inline' }, reply as never);

    expect(headers).toMatchObject({
      'Content-Type': 'application/octet-stream',
      'Content-Length': '5',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    expect(headers['Content-Disposition']).toMatch(/^attachment;/);
    expect(headers['Content-Disposition']).not.toMatch(/[\r\n]/);
    expect(reply.send).toHaveBeenCalledWith(body);
  });
});

describe('contentDisposition', () => {
  it('uses an ASCII fallback and RFC 5987 UTF-8 filename without header injection', () => {
    const header = contentDisposition('inline', '../季度\r\n报告.md', 'artifact_1');
    expect(header).toBe(
      'inline; filename="artifact-artifact_1.md"; filename*=UTF-8\'\'%E5%AD%A3%E5%BA%A6-%E6%8A%A5%E5%91%8A.md',
    );
  });
});

function user() {
  return { id: 'user_1', email: 'user@example.com', name: 'User', avatar: '' };
}
