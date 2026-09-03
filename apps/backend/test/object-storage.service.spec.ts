import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
