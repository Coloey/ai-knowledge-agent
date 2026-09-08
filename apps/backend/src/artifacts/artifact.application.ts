import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ArtifactRef } from '@agent/protocol';
import type { Readable } from 'node:stream';

import { ObjectStorageService } from '../storage/object-storage.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ArtifactRepository } from './artifact.repository';
import type { ArtifactDetail, ArtifactRequestInput } from './artifact.types';

export interface ArtifactRequestHandle {
  artifact: ArtifactRef;
  cancel: () => Promise<boolean>;
}

export interface ArtifactContentStream {
  body: Readable;
  filename: string;
  mimeType: string;
  size?: number;
  inlineAllowed: boolean;
}

const INLINE_MIME_TYPES = new Set([
  'text/markdown',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

@Injectable()
export class ArtifactApplication {
  constructor(
    @Inject(ArtifactRepository) private readonly repository: ArtifactRepository,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(ObjectStorageService) private readonly storage: ObjectStorageService,
  ) {}

  async requestFromAnswer(input: ArtifactRequestInput): Promise<ArtifactRequestHandle> {
    const request = await this.repository.requestFromAnswer(input);
    return {
      artifact: request.artifact,
      cancel: () =>
        request.cancellation ? this.repository.cancelRequest(request.cancellation) : Promise.resolve(false),
    };
  }

  async getAuthorized(userId: string, artifactId: string): Promise<ArtifactDetail> {
    const detail = await this.repository.findDetail(artifactId);
    if (!detail) throw new NotFoundException('Artifact not found');
    try {
      await this.workspaces.assertMember(userId, detail.workspace_id);
    } catch (error) {
      if (error instanceof ForbiddenException) throw new NotFoundException('Artifact not found');
      throw error;
    }
    return detail;
  }

  async openAuthorized(userId: string, artifactId: string): Promise<ArtifactContentStream> {
    const detail = await this.getAuthorized(userId, artifactId);
    if (detail.status !== 'completed') throw new ConflictException('Artifact content is not available');

    const content = await this.repository.findContent(artifactId, detail.workspace_id);
    if (!content) throw new NotFoundException('Artifact not found');
    if (content.status !== 'completed' || !content.storageKey || !content.mimeType || content.size === null) {
      throw new ConflictException('Artifact content is not available');
    }
    const mimeType = safeMimeType(content.mimeType);
    const opened = await this.storage.openStream(content.storageKey);
    return {
      body: opened.body,
      filename: artifactFilename(detail.title, mimeType),
      mimeType,
      size: content.size,
      inlineAllowed: INLINE_MIME_TYPES.has(mimeType),
    };
  }

  async retryAuthorized(userId: string, artifactId: string): Promise<ArtifactDetail> {
    const detail = await this.getAuthorized(userId, artifactId);
    return this.repository.retryFailed(artifactId, detail.workspace_id);
  }
}

function safeMimeType(value: string): string {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value)
    ? value.toLowerCase()
    : 'application/octet-stream';
}

function artifactFilename(title: string, mimeType: string): string {
  const extension = mimeType === 'text/markdown' ? '.md' : mimeType === 'text/plain' ? '.txt' : '';
  const base = title
    .replace(/[\\/\r\n]+/g, '-')
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
    .slice(0, 180);
  const name = base || 'artifact';
  return extension && !name.toLowerCase().endsWith(extension) ? `${name}${extension}` : name;
}
