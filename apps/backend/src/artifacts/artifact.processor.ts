import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';

import { GENERATE_ARTIFACT_JOB, ARTIFACT_GENERATION_QUEUE } from '../queue/queue.constants';
import { ObjectStorageService } from '../storage/object-storage.service';
import { ArtifactRepository } from './artifact.repository';
import { MarkdownReportRenderer } from './markdown-report.renderer';

export interface ArtifactGenerationJobData {
  artifactId: string;
  jobId: string;
  version: number;
}

@Processor(ARTIFACT_GENERATION_QUEUE, { concurrency: Number(process.env.QUEUE_CONCURRENCY || 2) })
export class ArtifactProcessor extends WorkerHost {
  constructor(
    @Inject(ArtifactRepository) private readonly repository: ArtifactRepository,
    @Inject(MarkdownReportRenderer) private readonly renderer: MarkdownReportRenderer,
    @Inject(ObjectStorageService) private readonly storage: ObjectStorageService,
  ) {
    super();
  }

  async process(job: Job<ArtifactGenerationJobData, void, string>): Promise<void> {
    if (job.name !== GENERATE_ARTIFACT_JOB) throw new Error(`Unsupported job ${job.name}`);
    const { artifactId, jobId, version } = job.data;
    if (!artifactId || !jobId || !Number.isSafeInteger(version) || version < 1)
      throw new Error('Invalid artifact generation job');

    const generation = await this.repository.loadGeneration(artifactId, jobId, version);
    if (!generation || generation.artifact.version !== version || generation.job.version !== version) return;
    if (generation.artifact.status === 'completed' && generation.job.status === 'completed') return;
    if (!(await this.repository.markProcessing(artifactId, jobId, version))) return;

    try {
      await job.updateProgress(10);
      const rendered = await this.renderer.render(
        { answerId: generation.artifact.answerId, title: generation.artifact.title },
        new AbortController().signal,
      );
      const stored = await this.storage.saveGenerated({
        workspaceId: generation.artifact.workspaceId,
        artifactId,
        version,
        filename: rendered.filename,
        contentType: rendered.contentType,
        stream: rendered.body,
      });
      if (
        await this.repository.completeGeneration(artifactId, jobId, version, {
          storageKey: stored.storageKey,
          size: stored.size,
          mimeType: stored.contentType,
        })
      ) {
        await job.updateProgress(100);
      }
    } catch (error) {
      await this.repository.failGeneration(
        artifactId,
        jobId,
        version,
        'ARTIFACT_GENERATION_FAILED',
        'Artifact generation failed',
      );
      throw error;
    }
  }
}
