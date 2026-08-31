import { Inject, Injectable } from '@nestjs/common';
import { and, cosineDistance, eq, isNotNull } from 'drizzle-orm';

import { EmbeddingService } from '../ai/embedding.service';
import { DatabaseService } from '../database/database.service';
import { documentChunks, libraryFiles } from '../database/schema';

export interface RetrievedChunk {
  chunk_id: string;
  file_id: string;
  file_title: string;
  page: number | null;
  content: string;
}

@Injectable()
export class RetrievalService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EmbeddingService) private readonly embeddings: EmbeddingService,
  ) {}

  async retrieve(workspaceId: string, query: string, limit = 5): Promise<RetrievedChunk[]> {
    const embedding = (await this.embeddings.embed([query]))[0];
    const distance = cosineDistance(documentChunks.embedding, embedding);
    const rows = await this.database.db
      .select({
        chunkId: documentChunks.id,
        fileId: documentChunks.fileId,
        fileTitle: libraryFiles.title,
        page: documentChunks.page,
        content: documentChunks.content,
      })
      .from(documentChunks)
      .innerJoin(libraryFiles, eq(libraryFiles.id, documentChunks.fileId))
      .where(and(eq(documentChunks.workspaceId, workspaceId), isNotNull(documentChunks.embedding)))
      .orderBy(distance)
      .limit(limit);
    return rows.map((row) => ({
      chunk_id: row.chunkId,
      file_id: row.fileId,
      file_title: row.fileTitle,
      page: row.page,
      content: row.content,
    }));
  }
}
