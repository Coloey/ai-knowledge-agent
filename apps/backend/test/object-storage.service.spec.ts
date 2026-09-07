import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Environment } from '../src/config/environment';
import { ObjectStorageService } from '../src/storage/object-storage.service';

const uploadOptions = vi.hoisted(() => vi.fn());
const uploadAbort = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const uploadFailure = vi.hoisted(() => ({ current: undefined as Error | undefined }));

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(options: unknown) {
      uploadOptions(options);
    }

    async done() {
      if (uploadFailure.current) throw uploadFailure.current;
      const options = uploadOptions.mock.calls.at(-1)?.[0] as {
        params: { Body: AsyncIterable<Uint8Array> };
      };
      for await (const _chunk of options.params.Body) {
        // Consume the upload body so size enforcement runs as it would for S3.
      }
    }

    async abort() {
      return uploadAbort();
    }
  },
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  uploadOptions.mockClear();
  uploadAbort.mockClear();
  uploadFailure.current = undefined;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ObjectStorageService', () => {
  it('saves, reads, and deletes a local upload inside the configured root', async () => {
    const directory = await temporaryDirectory();
    const storage = new ObjectStorageService(config({ LOCAL_STORAGE_DIR: directory }));

    const stored = await storage.saveUpload({
      stream: Readable.from([Buffer.from('hello')]),
      workspaceId: 'workspace_1',
      fileId: 'file_1',
      filename: '../../notes.txt',
      contentType: 'text/plain',
    });

    expect(stored).toEqual({ storageKey: 'workspace_1/file_1.txt', size: 5 });
    expect(await storage.readBuffer(stored.storageKey)).toEqual(Buffer.from('hello'));
    expect(await readFile(join(directory, stored.storageKey))).toEqual(Buffer.from('hello'));

    await storage.delete(stored.storageKey);
    await expect(storage.readBuffer(stored.storageKey)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps local user uploads exclusive when generated artifacts are replaceable', async () => {
    const directory = await temporaryDirectory();
    const storage = new ObjectStorageService(config({ LOCAL_STORAGE_DIR: directory }));
    const input = {
      workspaceId: 'workspace_1',
      fileId: 'file_1',
      filename: 'notes.txt',
      contentType: 'text/plain',
    };

    await storage.saveUpload({ ...input, stream: Readable.from([Buffer.from('first')]) });

    await expect(
      storage.saveUpload({ ...input, stream: Readable.from([Buffer.from('second')]) }),
    ).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(storage.readBuffer('workspace_1/file_1.txt')).resolves.toEqual(Buffer.from('first'));
  });

  it('rejects oversized uploads and removes the partial local object', async () => {
    const directory = await temporaryDirectory();
    const storage = new ObjectStorageService(config({ LOCAL_STORAGE_DIR: directory, MAX_UPLOAD_BYTES: 4 }));

    await expect(
      storage.saveUpload({
        stream: Readable.from([Buffer.from('hello')]),
        workspaceId: 'workspace_1',
        fileId: 'file_1',
        filename: 'notes.txt',
        contentType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(readFile(join(directory, 'workspace_1/file_1.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an exactly-at-limit stream truncated by Fastify and removes the stored prefix', async () => {
    const directory = await temporaryDirectory();
    const storage = new ObjectStorageService(config({ LOCAL_STORAGE_DIR: directory, MAX_UPLOAD_BYTES: 5 }));
    const stream = Readable.from([Buffer.from('hello')]) as Readable & { truncated: boolean };
    stream.truncated = true;

    await expect(
      storage.saveUpload({
        stream,
        workspaceId: 'workspace_1',
        fileId: 'file_1',
        filename: 'notes.txt',
        contentType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(readFile(join(directory, 'workspace_1/file_1.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('propagates an aborted source stream and removes the partial local object', async () => {
    const directory = await temporaryDirectory();
    const storage = new ObjectStorageService(config({ LOCAL_STORAGE_DIR: directory }));
    const stream = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('upload aborted'));
      },
    });

    await expect(
      storage.saveUpload({
        stream,
        workspaceId: 'workspace_1',
        fileId: 'file_1',
        filename: 'notes.txt',
        contentType: 'text/plain',
      }),
    ).rejects.toThrow('upload aborted');
    await expect(readFile(join(directory, 'workspace_1/file_1.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects local traversal for reads and deletes', async () => {
    const directory = await temporaryDirectory();
    const storage = new ObjectStorageService(config({ LOCAL_STORAGE_DIR: directory }));

    await expect(storage.readBuffer('../outside.txt')).rejects.toBeInstanceOf(BadRequestException);
    await expect(storage.delete('../outside.txt')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('writes generated files under a versioned artifact key and opens a stream without buffering the object', async () => {
    const directory = await temporaryDirectory();
    const storage = new ObjectStorageService(config({ LOCAL_STORAGE_DIR: directory, MAX_UPLOAD_BYTES: 9_000_000 }));
    const body = Buffer.alloc(8 * 1024 * 1024, 'x');

    const stored = await storage.saveGenerated({
      stream: Readable.from([body]),
      workspaceId: 'workspace_1',
      artifactId: 'artifact_1',
      version: 2,
      filename: '../../weekly report.md',
      contentType: 'text/markdown',
    });
    const opened = await storage.openStream(stored.storageKey);

    expect(stored).toEqual({
      storageKey: 'workspace_1/artifacts/artifact_1/v2/weekly-report.md',
      size: body.length,
      contentType: 'text/markdown',
    });
    expect(opened.body).toBeInstanceOf(Readable);
    expect(opened.size).toBe(body.length);
    expect(opened.contentType).toBe('text/markdown');
    expect((await stat(join(directory, stored.storageKey))).size).toBe(body.length);
    opened.body.destroy();

    await expect(
      storage.saveGenerated({
        stream: Readable.from([Buffer.from('nope')]),
        workspaceId: '../outside',
        artifactId: 'artifact_1',
        version: 1,
        filename: 'report.md',
        contentType: 'text/markdown',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('atomically replaces a generated file for a same-version worker retry and cleans up a failed replacement', async () => {
    const directory = await temporaryDirectory();
    const storage = new ObjectStorageService(config({ LOCAL_STORAGE_DIR: directory }));
    const input = {
      workspaceId: 'workspace_1',
      artifactId: 'artifact_1',
      version: 1,
      filename: 'report.md',
      contentType: 'text/markdown' as const,
    };

    await storage.saveGenerated({ ...input, stream: Readable.from([Buffer.from('before restart')]) });
    const retried = await storage.saveGenerated({ ...input, stream: Readable.from([Buffer.from('after restart')]) });

    expect(await storage.readBuffer(retried.storageKey)).toEqual(Buffer.from('after restart'));

    const interrupted = new Readable({
      read() {
        this.push(Buffer.from('partial replacement'));
        this.destroy(new Error('generated write interrupted'));
      },
    });
    await expect(storage.saveGenerated({ ...input, stream: interrupted })).rejects.toThrow(
      'generated write interrupted',
    );
    expect(await storage.readBuffer(retried.storageKey)).toEqual(Buffer.from('after restart'));
    await expect(readdir(join(directory, 'workspace_1/artifacts/artifact_1/v1'))).resolves.toEqual(['report.md']);
  });

  it('uses the configured S3 bucket for upload, read, delete, and health checks', async () => {
    const storage = new ObjectStorageService(
      config({ STORAGE_BACKEND: 's3', S3_BUCKET: 'knowledge-files', MAX_UPLOAD_BYTES: 16 }),
    );
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetObjectCommand') {
        return { Body: { transformToByteArray: async () => new Uint8Array(Buffer.from('stored')) } };
      }
      return {};
    });
    (storage as unknown as { s3Client: { send: typeof send } }).s3Client = { send };

    await expect(
      storage.saveUpload({
        stream: Readable.from([Buffer.from('hello')]),
        workspaceId: 'workspace_1',
        fileId: 'file_1',
        filename: 'notes.md',
        contentType: 'text/markdown',
      }),
    ).resolves.toEqual({ storageKey: 'workspace_1/file_1.md', size: 5 });
    expect(uploadOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.anything(),
        params: expect.objectContaining({ Bucket: 'knowledge-files', Key: 'workspace_1/file_1.md' }),
      }),
    );
    await expect(storage.readBuffer('workspace_1/file_1.md')).resolves.toEqual(Buffer.from('stored'));
    await storage.delete('workspace_1/file_1.md');
    await storage.healthCheck();
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      'GetObjectCommand',
      'DeleteObjectCommand',
      'HeadBucketCommand',
    ]);
  });

  it('uses the generated artifact key and returns the S3 response body as a stream', async () => {
    const storage = new ObjectStorageService(config({ STORAGE_BACKEND: 's3', S3_BUCKET: 'knowledge-files' }));
    const responseBody = Readable.from([Buffer.from('generated')]);
    const send = vi.fn().mockResolvedValue({ Body: responseBody, ContentLength: 9, ContentType: 'text/markdown' });
    (storage as unknown as { s3Client: { send: typeof send } }).s3Client = { send };

    await storage.saveGenerated({
      stream: Readable.from([Buffer.from('generated')]),
      workspaceId: 'workspace_1',
      artifactId: 'artifact_1',
      version: 1,
      filename: 'report.md',
      contentType: 'text/markdown',
    });
    const opened = await storage.openStream('workspace_1/artifacts/artifact_1/v1/report.md');

    expect(uploadOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          Bucket: 'knowledge-files',
          Key: 'workspace_1/artifacts/artifact_1/v1/report.md',
          ContentType: 'text/markdown',
        }),
      }),
    );
    expect(opened).toMatchObject({ body: responseBody, size: 9, contentType: 'text/markdown' });
  });

  it('enforces the upload limit while streaming to S3', async () => {
    const storage = new ObjectStorageService(config({ STORAGE_BACKEND: 's3', MAX_UPLOAD_BYTES: 4 }));

    await expect(
      storage.saveUpload({
        stream: Readable.from([Buffer.from('hello')]),
        workspaceId: 'workspace_1',
        fileId: 'file_1',
        filename: 'notes.txt',
        contentType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('propagates an aborted source stream to the S3 upload and cleans up the key', async () => {
    const storage = new ObjectStorageService(config({ STORAGE_BACKEND: 's3' }));
    const send = vi.fn().mockResolvedValue({});
    (storage as unknown as { s3Client: { send: typeof send } }).s3Client = { send };
    const stream = new Readable({
      read() {
        this.destroy(new Error('upload aborted'));
      },
    });

    await expect(
      storage.saveUpload({
        stream,
        workspaceId: 'workspace_1',
        fileId: 'file_1',
        filename: 'notes.txt',
        contentType: 'text/plain',
      }),
    ).rejects.toThrow('upload aborted');
    expect(send.mock.calls.at(-1)?.[0].constructor.name).toBe('DeleteObjectCommand');
  });

  it('destroys a still-streaming source when S3 rejects the upload early', async () => {
    const storage = new ObjectStorageService(config({ STORAGE_BACKEND: 's3' }));
    const send = vi.fn().mockResolvedValue({});
    (storage as unknown as { s3Client: { send: typeof send } }).s3Client = { send };
    uploadFailure.current = new Error('s3 rejected');
    let emitted = false;
    const stream = new Readable({
      read() {
        if (!emitted) {
          emitted = true;
          this.push(Buffer.from('partial'));
        }
      },
    });

    await expect(
      storage.saveUpload({
        stream,
        workspaceId: 'workspace_1',
        fileId: 'file_1',
        filename: 'notes.txt',
        contentType: 'text/plain',
      }),
    ).rejects.toThrow('s3 rejected');
    expect(stream.destroyed).toBe(true);
    expect(uploadAbort).toHaveBeenCalledOnce();
    expect(send.mock.calls.at(-1)?.[0].constructor.name).toBe('DeleteObjectCommand');
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-storage-'));
  temporaryDirectories.push(directory);
  return directory;
}

function config(overrides: Partial<Environment> = {}): ConfigService<Environment, true> {
  const values = {
    STORAGE_BACKEND: 'local',
    LOCAL_STORAGE_DIR: './storage',
    S3_ENDPOINT_URL: 'http://localhost:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'agent-files',
    S3_ACCESS_KEY: 'access',
    S3_SECRET_KEY: 'secret',
    S3_FORCE_PATH_STYLE: true,
    MAX_UPLOAD_BYTES: 1024,
    ...overrides,
  } as Environment;
  return { get: (key: keyof Environment) => values[key] } as ConfigService<Environment, true>;
}
