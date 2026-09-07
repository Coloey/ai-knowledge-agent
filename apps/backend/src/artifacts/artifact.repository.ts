import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ArtifactRef } from '@agent/protocol';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { newId } from '../database/id';
import { artifactJobs, artifacts, chatAnswerEvents, chatAnswers, chatSessions, outboxEvents } from '../database/schema';
import type {
  ArtifactCancellationInput,
  ArtifactDetail,
  ArtifactRequestInput,
  StoredArtifactContent,
} from './artifact.types';

export interface StoredAnswerEvent {
  type: string;
  contentJson: Record<string, unknown>;
}

export interface ArtifactGeneration {
  artifact: {
    id: string;
    workspaceId: string;
    answerId: string;
    title: string;
    status: string;
    version: number;
  };
  job: {
    id: string;
    version: number;
    status: string;
  };
}

export interface CompletedArtifactGeneration {
  storageKey: string;
  size: number;
  mimeType: string;
}

export interface ArtifactRequestResult {
  artifact: ArtifactRef;
  cancellation?: ArtifactCancellationInput;
}

class ArtifactCancellationRace extends Error {}

const PUBLIC_ARTIFACT_FAILURE = {
  error_code: 'ARTIFACT_GENERATION_FAILED',
  error_message: 'Artifact generation failed',
} as const;

@Injectable()
export class ArtifactRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async requestFromAnswer(input: ArtifactRequestInput): Promise<ArtifactRequestResult> {
    return this.database.db.transaction(async (tx) => {
      const [answer] = await tx
        .select({ answerId: chatAnswers.id, sessionId: chatAnswers.sessionId, workspaceId: chatSessions.workspaceId })
        .from(chatAnswers)
        .innerJoin(chatSessions, eq(chatSessions.id, chatAnswers.sessionId))
        .where(eq(chatAnswers.id, input.answerId))
        .limit(1);
      if (!answer || answer.sessionId !== input.sessionId || answer.workspaceId !== input.workspaceId) {
        throw new NotFoundException('Answer not found');
      }

      const [created] = await tx
        .insert(artifacts)
        .values({
          id: newId('artifact'),
          workspaceId: answer.workspaceId,
          sessionId: answer.sessionId,
          answerId: answer.answerId,
          kind: input.kind,
          title: input.title.trim() || 'Untitled document',
          status: 'queued',
          version: 1,
          errorMessage: '',
        })
        .onConflictDoNothing({ target: [artifacts.answerId, artifacts.kind, artifacts.version] })
        .returning({
          id: artifacts.id,
          kind: artifacts.kind,
          title: artifacts.title,
          status: artifacts.status,
          version: artifacts.version,
        });
      const artifact =
        created ??
        (
          await tx
            .select({
              id: artifacts.id,
              kind: artifacts.kind,
              title: artifacts.title,
              status: artifacts.status,
              version: artifacts.version,
            })
            .from(artifacts)
            .where(
              and(eq(artifacts.answerId, input.answerId), eq(artifacts.kind, input.kind), eq(artifacts.version, 1)),
            )
            .limit(1)
        )[0];
      if (!artifact) throw new Error('Artifact was not created');

      const [job] = await tx
        .insert(artifactJobs)
        .values({
          id: newId('artifact_job'),
          artifactId: artifact.id,
          version: artifact.version,
          status: 'pending',
          progress: 0,
        })
        .onConflictDoNothing({ target: [artifactJobs.artifactId, artifactJobs.version] })
        .returning({ id: artifactJobs.id });
      if (job) {
        await tx.insert(outboxEvents).values({
          id: newId('outbox'),
          aggregateType: 'artifact',
          aggregateId: artifact.id,
          eventType: 'artifact.generation.requested',
          payloadJson: { artifactId: artifact.id, jobId: job.id, version: artifact.version },
        });
      }

      return {
        artifact: {
          id: artifact.id,
          kind: artifact.kind as ArtifactRef['kind'],
          title: artifact.title,
          status: artifact.status as ArtifactRef['status'],
        },
        ...(job
          ? {
              cancellation: {
                artifactId: artifact.id,
                jobId: job.id,
                version: artifact.version,
                deleteArtifact: Boolean(created),
              },
            }
          : {}),
      };
    });
  }

  async cancelRequest(input: ArtifactCancellationInput): Promise<boolean> {
    try {
      return await this.database.db.transaction(async (tx) => {
        const [job] = await tx
          .select({ id: artifactJobs.id, status: artifactJobs.status })
          .from(artifactJobs)
          .where(
            and(
              eq(artifactJobs.id, input.jobId),
              eq(artifactJobs.artifactId, input.artifactId),
              eq(artifactJobs.version, input.version),
            ),
          )
          .limit(1)
          .for('update');
        if (!job || job.status !== 'pending') return false;

        const [outbox] = await tx
          .select({ id: outboxEvents.id, publishedAt: outboxEvents.publishedAt })
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.aggregateId, input.artifactId),
              eq(outboxEvents.eventType, 'artifact.generation.requested'),
              sql`${outboxEvents.payloadJson}->>'jobId' = ${input.jobId}`,
            ),
          )
          .limit(1)
          .for('update');
        if (!outbox || outbox.publishedAt !== null) return false;

        if (input.deleteArtifact) {
          const [artifact] = await tx
            .select({ id: artifacts.id, status: artifacts.status })
            .from(artifacts)
            .where(eq(artifacts.id, input.artifactId))
            .limit(1)
            .for('update');
          if (!artifact || artifact.status !== 'queued') return false;
        }

        const [deletedOutbox] = await tx
          .delete(outboxEvents)
          .where(and(eq(outboxEvents.id, outbox.id), isNull(outboxEvents.publishedAt)))
          .returning({ id: outboxEvents.id });
        if (!deletedOutbox) throw new ArtifactCancellationRace();

        const [deletedJob] = await tx
          .delete(artifactJobs)
          .where(and(eq(artifactJobs.id, job.id), eq(artifactJobs.status, 'pending')))
          .returning({ id: artifactJobs.id });
        if (!deletedJob) throw new ArtifactCancellationRace();

        if (input.deleteArtifact) {
          const [deletedArtifact] = await tx
            .delete(artifacts)
            .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.status, 'queued')))
            .returning({ id: artifacts.id });
          if (!deletedArtifact) throw new ArtifactCancellationRace();
        }
        return true;
      });
    } catch (error) {
      if (error instanceof ArtifactCancellationRace) return false;
      throw error;
    }
  }

  async answerEvents(answerId: string): Promise<StoredAnswerEvent[]> {
    return this.database.db
      .select({ type: chatAnswerEvents.type, contentJson: chatAnswerEvents.contentJson })
      .from(chatAnswerEvents)
      .where(eq(chatAnswerEvents.answerId, answerId))
      .orderBy(asc(chatAnswerEvents.seq));
  }

  async findDetail(artifactId: string): Promise<ArtifactDetail | undefined> {
    const [row] = await this.database.db
      .select({
        id: artifacts.id,
        workspaceId: artifacts.workspaceId,
        sessionId: artifacts.sessionId,
        answerId: artifacts.answerId,
        kind: artifacts.kind,
        title: artifacts.title,
        status: artifacts.status,
        mimeType: artifacts.mimeType,
        size: artifacts.size,
        progress: artifactJobs.progress,
        version: artifacts.version,
        errorCode: artifacts.errorCode,
        errorMessage: artifacts.errorMessage,
        createdAt: artifacts.createdAt,
        updatedAt: artifacts.updatedAt,
      })
      .from(artifacts)
      .leftJoin(
        artifactJobs,
        and(eq(artifactJobs.artifactId, artifacts.id), eq(artifactJobs.version, artifacts.version)),
      )
      .where(eq(artifacts.id, artifactId))
      .limit(1);
    return row ? this.detail(row) : undefined;
  }

  async findContent(artifactId: string, workspaceId: string): Promise<StoredArtifactContent | undefined> {
    const [row] = await this.database.db
      .select({
        status: artifacts.status,
        storageKey: artifacts.storageKey,
        mimeType: artifacts.mimeType,
        size: artifacts.size,
      })
      .from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, workspaceId)))
      .limit(1);
    return row as StoredArtifactContent | undefined;
  }

  async retryFailed(artifactId: string, workspaceId: string): Promise<ArtifactDetail> {
    return this.database.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          id: artifacts.id,
          workspaceId: artifacts.workspaceId,
          sessionId: artifacts.sessionId,
          answerId: artifacts.answerId,
          kind: artifacts.kind,
          title: artifacts.title,
          status: artifacts.status,
          version: artifacts.version,
          createdAt: artifacts.createdAt,
        })
        .from(artifacts)
        .where(eq(artifacts.id, artifactId))
        .limit(1)
        .for('update');
      if (!current) throw new NotFoundException('Artifact not found');
      if (current.workspaceId !== workspaceId) throw new NotFoundException('Artifact not found');
      if (current.status !== 'failed') throw new ConflictException('Only failed artifacts can be retried');

      const now = new Date();
      const nextVersion = current.version + 1;
      const [retried] = await tx
        .update(artifacts)
        .set({
          status: 'queued',
          version: nextVersion,
          mimeType: null,
          size: null,
          storageKey: null,
          errorCode: null,
          errorMessage: '',
          updatedAt: now,
        })
        .where(
          and(eq(artifacts.id, artifactId), eq(artifacts.status, 'failed'), eq(artifacts.version, current.version)),
        )
        .returning({ id: artifacts.id });
      if (!retried) throw new ConflictException('Artifact state changed');

      const jobId = newId('artifact_job');
      await tx.insert(artifactJobs).values({
        id: jobId,
        artifactId,
        version: nextVersion,
        status: 'pending',
        progress: 0,
      });
      await tx.insert(outboxEvents).values({
        id: newId('outbox'),
        aggregateType: 'artifact',
        aggregateId: artifactId,
        eventType: 'artifact.generation.requested',
        payloadJson: { artifactId, jobId, version: nextVersion },
      });

      return {
        id: current.id,
        kind: current.kind as ArtifactDetail['kind'],
        title: current.title,
        status: 'queued',
        workspace_id: current.workspaceId,
        session_id: current.sessionId,
        answer_id: current.answerId,
        progress: 0,
        version: nextVersion,
        created_at: current.createdAt.getTime(),
        updated_at: now.getTime(),
      };
    });
  }

  async loadGeneration(artifactId: string, jobId: string, version: number): Promise<ArtifactGeneration | undefined> {
    const [generation] = await this.database.db
      .select({
        artifact: {
          id: artifacts.id,
          workspaceId: artifacts.workspaceId,
          answerId: artifacts.answerId,
          title: artifacts.title,
          status: artifacts.status,
          version: artifacts.version,
        },
        job: {
          id: artifactJobs.id,
          version: artifactJobs.version,
          status: artifactJobs.status,
        },
      })
      .from(artifacts)
      .innerJoin(artifactJobs, eq(artifactJobs.artifactId, artifacts.id))
      .where(and(eq(artifacts.id, artifactId), eq(artifactJobs.id, jobId), eq(artifactJobs.version, version)))
      .limit(1);
    return generation;
  }

  async markProcessing(artifactId: string, jobId: string, version: number): Promise<boolean> {
    const now = new Date();
    return this.database.db.transaction(async (tx) => {
      const [artifact] = await tx
        .update(artifacts)
        .set({ status: 'processing', errorCode: null, errorMessage: '', updatedAt: now })
        .where(and(eq(artifacts.id, artifactId), eq(artifacts.version, version), ne(artifacts.status, 'completed')))
        .returning({ id: artifacts.id });
      if (!artifact) return false;

      const [job] = await tx
        .update(artifactJobs)
        .set({
          status: 'processing',
          progress: 10,
          attempts: sql`${artifactJobs.attempts} + 1`,
          errorCode: null,
          errorMessage: '',
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(artifactJobs.id, jobId),
            eq(artifactJobs.artifactId, artifactId),
            eq(artifactJobs.version, version),
            ne(artifactJobs.status, 'completed'),
          ),
        )
        .returning({ id: artifactJobs.id });
      return Boolean(job);
    });
  }

  async completeGeneration(
    artifactId: string,
    jobId: string,
    version: number,
    output: CompletedArtifactGeneration,
  ): Promise<boolean> {
    const now = new Date();
    return this.database.db.transaction(async (tx) => {
      const [artifact] = await tx
        .update(artifacts)
        .set({
          status: 'completed',
          storageKey: output.storageKey,
          size: output.size,
          mimeType: output.mimeType,
          errorCode: null,
          errorMessage: '',
          updatedAt: now,
        })
        .where(and(eq(artifacts.id, artifactId), eq(artifacts.version, version), ne(artifacts.status, 'completed')))
        .returning({ id: artifacts.id });
      if (!artifact) return false;

      const [job] = await tx
        .update(artifactJobs)
        .set({
          status: 'completed',
          progress: 100,
          errorCode: null,
          errorMessage: '',
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(eq(artifactJobs.id, jobId), eq(artifactJobs.artifactId, artifactId), eq(artifactJobs.version, version)),
        )
        .returning({ id: artifactJobs.id });
      return Boolean(job);
    });
  }

  async failGeneration(
    artifactId: string,
    jobId: string,
    version: number,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    const now = new Date();
    return this.database.db.transaction(async (tx) => {
      const [artifact] = await tx
        .update(artifacts)
        .set({ status: 'failed', errorCode, errorMessage, updatedAt: now })
        .where(and(eq(artifacts.id, artifactId), eq(artifacts.version, version), ne(artifacts.status, 'completed')))
        .returning({ id: artifacts.id });
      if (!artifact) return false;

      const [job] = await tx
        .update(artifactJobs)
        .set({ status: 'failed', errorCode, errorMessage, completedAt: now, updatedAt: now })
        .where(
          and(eq(artifactJobs.id, jobId), eq(artifactJobs.artifactId, artifactId), eq(artifactJobs.version, version)),
        )
        .returning({ id: artifactJobs.id });
      return Boolean(job);
    });
  }

  private detail(row: {
    id: string;
    workspaceId: string;
    sessionId: string;
    answerId: string;
    kind: string;
    title: string;
    status: string;
    mimeType: string | null;
    size: number | null;
    progress: number | null;
    version: number;
    errorCode: string | null;
    errorMessage: string;
    createdAt: Date;
    updatedAt: Date;
  }): ArtifactDetail {
    return {
      id: row.id,
      kind: row.kind as ArtifactDetail['kind'],
      title: row.title,
      status: row.status as ArtifactDetail['status'],
      workspace_id: row.workspaceId,
      session_id: row.sessionId,
      answer_id: row.answerId,
      ...(row.mimeType ? { mime_type: row.mimeType } : {}),
      ...(row.size === null ? {} : { size: row.size }),
      progress: row.progress ?? (row.status === 'completed' ? 100 : 0),
      version: row.version,
      ...(row.status === 'failed' && (row.errorCode || row.errorMessage) ? PUBLIC_ARTIFACT_FAILURE : {}),
      created_at: row.createdAt.getTime(),
      updated_at: row.updatedAt.getTime(),
    };
  }
}
