import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { BadRequestException, Inject, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../config/environment';

export interface SaveUploadInput {
  stream: Readable & { truncated?: boolean };
  workspaceId: string;
  fileId: string;
  filename: string;
  contentType?: string;
}

export interface StoredUpload {
  storageKey: string;
  size: number;
}

export interface SaveGeneratedInput {
  stream: Readable;
  workspaceId: string;
  artifactId: string;
  version: number;
  filename: string;
  contentType: 'text/markdown';
}

export interface StoredGeneratedFile extends StoredUpload {
  contentType: string;
}

export interface OpenedObjectStream {
  body: Readable;
  size?: number;
  contentType?: string;
}

@Injectable()
export class ObjectStorageService {
  private readonly backend: Environment['STORAGE_BACKEND'];
  private readonly localRoot: string;
  private readonly bucket: string;
  private readonly maxUploadBytes: number;
  private s3Client: S3Client;

  constructor(@Inject(ConfigService) private readonly config: ConfigService<Environment, true>) {
    this.backend = config.get('STORAGE_BACKEND', { infer: true });
    this.localRoot = resolve(config.get('LOCAL_STORAGE_DIR', { infer: true }));
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.maxUploadBytes = config.get('MAX_UPLOAD_BYTES', { infer: true });
    const accessKeyId = config.get('S3_ACCESS_KEY', { infer: true });
    const secretAccessKey = config.get('S3_SECRET_KEY', { infer: true });
    this.s3Client = new S3Client({
      region: config.get('S3_REGION', { infer: true }),
      endpoint: config.get('S3_ENDPOINT_URL', { infer: true }),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    });
  }

  async saveUpload(input: SaveUploadInput): Promise<StoredUpload> {
    const storageKey = this.storageKey(input.workspaceId, input.fileId, input.filename);
    let multipartLimitReached = false;
    const onMultipartLimit = () => {
      multipartLimitReached = true;
    };
    input.stream.once('limit', onMultipartLimit);

    try {
      return await this.saveStream({
        storageKey,
        stream: input.stream,
        contentType: input.contentType,
        assertComplete: () => this.assertCompleteUpload(input.stream, multipartLimitReached),
      });
    } finally {
      input.stream.off('limit', onMultipartLimit);
    }
  }

  async saveGenerated(input: SaveGeneratedInput): Promise<StoredGeneratedFile> {
    if (!Number.isSafeInteger(input.version) || input.version < 1) {
      throw new BadRequestException('Invalid artifact version');
    }
    const storageKey = this.generatedStorageKey(input.workspaceId, input.artifactId, input.version, input.filename);
    const stored =
      this.backend === 'local'
        ? await this.saveGeneratedLocally(storageKey, input.stream)
        : await this.saveStream({ storageKey, stream: input.stream, contentType: input.contentType });
    return { ...stored, contentType: input.contentType };
  }

  async readBuffer(storageKey: string): Promise<Buffer> {
    if (this.backend === 's3') {
      const response = await this.s3Client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }));
      if (!response.Body) throw new Error(`Object ${storageKey} has no body`);
      return Buffer.from(await response.Body.transformToByteArray());
    }
    return readFile(await this.localReadTarget(storageKey));
  }

  async openStream(storageKey: string): Promise<OpenedObjectStream> {
    if (this.backend === 's3') {
      const response = await this.s3Client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }));
      if (!response.Body || !(response.Body instanceof Readable))
        throw new Error(`Object ${storageKey} has no readable body`);
      return {
        body: response.Body,
        ...(response.ContentLength === undefined ? {} : { size: response.ContentLength }),
        ...(response.ContentType ? { contentType: response.ContentType } : {}),
      };
    }
    const target = await this.localReadTarget(storageKey);
    const details = await stat(target);
    return { body: createReadStream(target), size: details.size, contentType: this.contentTypeFor(storageKey) };
  }

  async delete(storageKey: string): Promise<void> {
    if (this.backend === 's3') {
      await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }));
      return;
    }
    await rm(await this.localDeleteTarget(storageKey), { force: true });
  }

  async healthCheck(): Promise<void> {
    if (this.backend === 's3') {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    }
    await mkdir(this.localRoot, { recursive: true });
    await access(this.localRoot, constants.R_OK | constants.W_OK);
  }

  private storageKey(workspaceId: string, fileId: string, filename: string): string {
    const suffix = extname(basename(filename));
    const key = `${workspaceId}/${fileId}${suffix}`;
    this.assertContained(resolve(this.localRoot, key));
    return key;
  }

  private generatedStorageKey(workspaceId: string, artifactId: string, version: number, filename: string): string {
    const key = `${this.pathSegment(workspaceId)}/artifacts/${this.pathSegment(artifactId)}/v${version}/${this.safeFilename(filename)}`;
    this.assertContained(resolve(this.localRoot, key));
    return key;
  }

  private async saveStream(input: {
    storageKey: string;
    stream: Readable;
    contentType?: string;
    assertComplete?: () => void;
  }): Promise<StoredUpload> {
    const limited = new UploadSizeLimitStream(this.maxUploadBytes);
    let localTarget: string | undefined;
    try {
      if (this.backend === 's3') {
        const upload = new Upload({
          client: this.s3Client,
          params: {
            Bucket: this.bucket,
            Key: input.storageKey,
            Body: limited,
            ...(input.contentType ? { ContentType: input.contentType } : {}),
          },
          leavePartsOnError: false,
        });
        const pump = pipeline(input.stream, limited);
        const uploaded = upload.done();
        try {
          await Promise.all([pump, uploaded]);
        } catch (error) {
          input.stream.destroy();
          limited.destroy();
          await upload.abort().catch(() => undefined);
          await Promise.allSettled([pump, uploaded]);
          throw error;
        }
        input.assertComplete?.();
        return { storageKey: input.storageKey, size: limited.size };
      }

      localTarget = await this.localUploadTarget(input.storageKey);
      await pipeline(input.stream, limited, createWriteStream(localTarget, { flags: 'wx' }));
      input.assertComplete?.();
      return { storageKey: input.storageKey, size: limited.size };
    } catch (error) {
      if (this.backend === 's3') {
        await this.s3Client
          .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: input.storageKey }))
          .catch(() => undefined);
      } else if (localTarget && !isFileAlreadyPresent(error)) {
        await rm(localTarget, { force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async saveGeneratedLocally(storageKey: string, stream: Readable): Promise<StoredUpload> {
    const target = await this.localUploadTarget(storageKey);
    const temporaryTarget = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    const limited = new UploadSizeLimitStream(this.maxUploadBytes);
    try {
      await pipeline(stream, limited, createWriteStream(temporaryTarget, { flags: 'wx' }));
      await rename(temporaryTarget, target);
      return { storageKey, size: limited.size };
    } catch (error) {
      stream.destroy();
      limited.destroy();
      await rm(temporaryTarget, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private assertCompleteUpload(stream: SaveUploadInput['stream'], multipartLimitReached: boolean): void {
    if (multipartLimitReached || stream.truncated) throw this.uploadTooLarge();
  }

  private uploadTooLarge(): PayloadTooLargeException {
    return new PayloadTooLargeException(`Upload exceeds ${this.maxUploadBytes} bytes`);
  }

  private async localUploadTarget(storageKey: string): Promise<string> {
    const target = this.lexicalTarget(storageKey);
    await mkdir(this.localRoot, { recursive: true });
    await mkdir(dirname(target), { recursive: true });
    const [root, parent] = await Promise.all([realpath(this.localRoot), realpath(dirname(target))]);
    this.assertContained(parent, root);
    return resolve(parent, basename(target));
  }

  private async localReadTarget(storageKey: string): Promise<string> {
    const target = this.lexicalTarget(storageKey);
    const [root, actual] = await Promise.all([realpath(this.localRoot), realpath(target)]);
    this.assertContained(actual, root);
    return actual;
  }

  private async localDeleteTarget(storageKey: string): Promise<string> {
    const target = this.lexicalTarget(storageKey);
    try {
      const [root, actual] = await Promise.all([realpath(this.localRoot), realpath(target)]);
      this.assertContained(actual, root);
    } catch (error) {
      if (!isFileMissing(error)) throw error;
    }
    return target;
  }

  private lexicalTarget(storageKey: string): string {
    if (!storageKey || isAbsolute(storageKey)) throw new BadRequestException('Invalid storage key');
    const target = resolve(this.localRoot, storageKey);
    this.assertContained(target);
    return target;
  }

  private pathSegment(value: string): string {
    if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
      throw new BadRequestException('Invalid storage path segment');
    }
    return value;
  }

  private safeFilename(filename: string): string {
    const normalized = basename(filename)
      .replace(/[\\/\r\n\0]+/g, '-')
      .replace(/\s+/g, '-')
      .trim();
    const safe = normalized.replace(/^-+|-+$/g, '');
    if (!safe || safe === '.' || safe === '..') throw new BadRequestException('Invalid generated filename');
    return safe.slice(0, 255);
  }

  private contentTypeFor(storageKey: string): string | undefined {
    return extname(storageKey).toLowerCase() === '.md' ? 'text/markdown' : undefined;
  }

  private assertContained(target: string, root = this.localRoot): void {
    const pathFromRoot = relative(root, target);
    if (
      pathFromRoot === '..' ||
      pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(pathFromRoot)
    ) {
      throw new BadRequestException('Storage key escapes the configured root');
    }
  }
}

class UploadSizeLimitStream extends Transform {
  size = 0;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.size += bytes.length;
    if (this.size > this.limit) {
      callback(new PayloadTooLargeException(`Upload exceeds ${this.limit} bytes`));
      return;
    }
    callback(null, bytes);
  }
}

function isFileMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isFileAlreadyPresent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}
