import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';

import { EmbeddingService } from '../ai/embedding.service';
import { DatabaseService } from '../database/database.service';
import { newId } from '../database/id';
import { documentChunks, libraryFiles } from '../database/schema';
import { ObjectStorageService } from '../storage/object-storage.service';
import { splitText } from './text-splitter';
import { TikaClientService } from './tika-client.service';

@Injectable()
export class LibraryParserService {
  private readonly logger = new Logger(LibraryParserService.name);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ObjectStorageService) private readonly storage: ObjectStorageService,
    @Inject(TikaClientService) private readonly tika: TikaClientService,
    @Inject(EmbeddingService) private readonly embeddings: EmbeddingService,
  ) {}

  async parse(fileId: string): Promise<void> {
    const file = await this.database.db.query.libraryFiles.findFirst({ where: eq(libraryFiles.id, fileId) });
    if (!file || file.parseStatus === 'ready') return;
    await this.database.db
      .update(libraryFiles)
      .set({ parseStatus: 'parsing', errorMessage: '', updatedAt: new Date() })
      .where(and(eq(libraryFiles.id, fileId), inArray(libraryFiles.parseStatus, ['pending', 'failed', 'parsing'])));

    try {
      const content = await this.storage.readBuffer(file.storageKey);
      const pages = await this.tika.extract(content, file.fileType);
      const chunks = splitText(pages);
      const vectors: number[][] = [];
      for (let index = 0; index < chunks.length; index += 32) {
        vectors.push(...(await this.embeddings.embed(chunks.slice(index, index + 32).map((chunk) => chunk.content))));
      }

      await this.database.db.transaction(async (tx) => {
        await tx.delete(documentChunks).where(eq(documentChunks.fileId, fileId));
        for (let index = 0; index < chunks.length; index += 250) {
          const batch = chunks.slice(index, index + 250).map((chunk, offset) => ({
            id: newId('chunk'),
            fileId,
            workspaceId: file.workspaceId,
            content: chunk.content,
            page: chunk.page,
            startOffset: chunk.startOffset,
            endOffset: chunk.endOffset,
            embedding: vectors[index + offset],
          }));
          if (batch.length) await tx.insert(documentChunks).values(batch);
        }
        await tx
          .update(libraryFiles)
          .set({ parseStatus: 'ready', errorMessage: '', updatedAt: new Date() })
          .where(eq(libraryFiles.id, fileId));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown parser error';
      this.logger.error({ fileId, error: message }, 'Library file parsing failed');
      await this.database.db
        .update(libraryFiles)
        .set({ parseStatus: 'failed', errorMessage: message.slice(0, 4_000), updatedAt: new Date() })
        .where(eq(libraryFiles.id, fileId));
      throw error;
    }
  }
}
