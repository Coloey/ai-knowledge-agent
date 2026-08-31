import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { MultipartFile } from '@fastify/multipart';
import { and, desc, eq } from 'drizzle-orm';

import type { AuthenticatedUser } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { newId } from '../database/id';
import { documentChunks, libraryFiles, outboxEvents } from '../database/schema';
import { ObjectStorageService } from '../storage/object-storage.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import type { LibraryFileDto } from './library.dto';

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.txt', '.md', '.markdown']);

@Injectable()
export class LibraryService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ObjectStorageService) private readonly storage: ObjectStorageService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
  ) {}

  async upload(user: AuthenticatedUser, workspaceId: string, upload: MultipartFile): Promise<LibraryFileDto> {
    await this.workspaces.assertMember(user.id, workspaceId);
    const extension = this.extension(upload.filename);
    if (!ALLOWED_EXTENSIONS.has(extension)) throw new BadRequestException('Unsupported file type');
    const fileId = newId('file');
    const stored = await this.storage.saveUpload({
      stream: upload.file,
      workspaceId,
      fileId,
      filename: upload.filename,
      contentType: upload.mimetype,
    });
    const file = {
      id: fileId,
      workspaceId,
      uploaderId: user.id,
      title: upload.filename || 'Untitled',
      fileType: upload.mimetype || extension.slice(1),
      size: stored.size,
      storageKey: stored.storageKey,
      parseStatus: 'pending',
      errorMessage: '',
    };

    try {
      await this.database.db.transaction(async (tx) => {
        await tx.insert(libraryFiles).values(file);
        await tx.insert(outboxEvents).values({
          id: newId('outbox'),
          aggregateType: 'library_file',
          aggregateId: file.id,
          eventType: 'library.file.uploaded',
          payloadJson: { fileId: file.id },
        });
      });
    } catch (error) {
      await this.storage.delete(stored.storageKey).catch(() => undefined);
      throw error;
    }
    return this.dto(file);
  }

  async list(userId: string, workspaceId: string): Promise<LibraryFileDto[]> {
    await this.workspaces.assertMember(userId, workspaceId);
    const files = await this.database.db
      .select()
      .from(libraryFiles)
      .where(eq(libraryFiles.workspaceId, workspaceId))
      .orderBy(desc(libraryFiles.createdAt));
    return files.map((file) => this.dto(file));
  }

  async get(userId: string, workspaceId: string, fileId: string): Promise<LibraryFileDto> {
    await this.workspaces.assertMember(userId, workspaceId);
    const file = await this.database.db.query.libraryFiles.findFirst({
      where: and(eq(libraryFiles.id, fileId), eq(libraryFiles.workspaceId, workspaceId)),
    });
    if (!file) throw new NotFoundException('File not found');
    return this.dto(file);
  }

  async delete(userId: string, workspaceId: string, fileId: string): Promise<void> {
    await this.workspaces.assertMember(userId, workspaceId);
    const file = await this.database.db.query.libraryFiles.findFirst({
      where: and(eq(libraryFiles.id, fileId), eq(libraryFiles.workspaceId, workspaceId)),
    });
    if (!file) throw new NotFoundException('File not found');
    await this.database.db.transaction(async (tx) => {
      // The legacy Alembic schema does not have ON DELETE CASCADE on document chunks.
      await tx.delete(documentChunks).where(eq(documentChunks.fileId, fileId));
      await tx.insert(outboxEvents).values({
        id: newId('outbox'),
        aggregateType: 'library_file',
        aggregateId: file.id,
        eventType: 'library.file.deleted',
        payloadJson: { storageKey: file.storageKey },
      });
      await tx.delete(libraryFiles).where(eq(libraryFiles.id, fileId));
    });
  }

  private extension(filename: string): string {
    const dot = filename.lastIndexOf('.');
    return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  }

  private dto(file: {
    id: string;
    workspaceId: string;
    title: string;
    fileType: string;
    size: number;
    parseStatus: string;
    errorMessage: string;
  }): LibraryFileDto {
    return {
      file_id: file.id,
      workspace_id: file.workspaceId,
      title: file.title,
      file_type: file.fileType,
      size: file.size,
      parse_status: file.parseStatus,
      error_message: file.errorMessage,
    };
  }
}
