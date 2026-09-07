import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import type { Queue } from 'bullmq';

import { DatabaseService } from '../database/database.service';
import { outboxEvents } from '../database/schema';
import {
  ARTIFACT_GENERATION_QUEUE,
  DELETE_LIBRARY_OBJECT_JOB,
  GENERATE_ARTIFACT_JOB,
  LIBRARY_PARSE_QUEUE,
  PARSE_LIBRARY_FILE_JOB,
} from '../queue/queue.constants';

@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @InjectQueue(LIBRARY_PARSE_QUEUE) private readonly queue: Queue,
    @InjectQueue(ARTIFACT_GENERATION_QUEUE) private readonly artifactQueue: Queue,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.dispatch(), 5_000);
    this.timer.unref();
    void this.dispatch();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async dispatch(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.database.db.transaction(async (tx) => {
        const events = await tx
          .select()
          .from(outboxEvents)
          .where(and(isNull(outboxEvents.publishedAt), lte(outboxEvents.availableAt, new Date())))
          .orderBy(asc(outboxEvents.createdAt))
          .limit(20)
          .for('update', { skipLocked: true });
        for (const event of events) {
          try {
            if (event.eventType === 'library.file.uploaded') {
              const fileId = String(event.payloadJson.fileId || '');
              await this.queue.add(PARSE_LIBRARY_FILE_JOB, { fileId }, { jobId: `parse-${fileId}` });
            } else if (event.eventType === 'library.file.deleted') {
              const storageKey = String(event.payloadJson.storageKey || '');
              await this.queue.add(DELETE_LIBRARY_OBJECT_JOB, { storageKey }, { jobId: `delete-${event.id}` });
            } else if (event.eventType === 'artifact.generation.requested') {
              const artifactId = String(event.payloadJson.artifactId || '');
              const jobId = String(event.payloadJson.jobId || '');
              const version = Number(event.payloadJson.version);
              if (!artifactId || !jobId || !Number.isSafeInteger(version) || version < 1) {
                throw new Error('Invalid artifact generation event');
              }
              await this.artifactQueue.add(
                GENERATE_ARTIFACT_JOB,
                { artifactId, jobId, version },
                { jobId: `artifact:${artifactId}:v${version}` },
              );
            } else {
              throw new Error(`Unsupported outbox event ${event.eventType}`);
            }
            await tx
              .update(outboxEvents)
              .set({ publishedAt: new Date(), updatedAt: new Date(), lastError: '' })
              .where(eq(outboxEvents.id, event.id));
          } catch (error) {
            const attempts = event.attempts + 1;
            await tx
              .update(outboxEvents)
              .set({
                attempts,
                availableAt: new Date(Date.now() + Math.min(60_000, 2 ** attempts * 1_000)),
                lastError: error instanceof Error ? error.message.slice(0, 4_000) : 'Queue publish failed',
                updatedAt: new Date(),
              })
              .where(eq(outboxEvents.id, event.id));
          }
        }
      });
    } catch (error) {
      this.logger.error(error, 'Outbox dispatch failed');
    } finally {
      this.running = false;
    }
  }
}
