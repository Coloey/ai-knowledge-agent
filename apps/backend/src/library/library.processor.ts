import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';

import { DELETE_LIBRARY_OBJECT_JOB, LIBRARY_PARSE_QUEUE, PARSE_LIBRARY_FILE_JOB } from '../queue/queue.constants';
import { ObjectStorageService } from '../storage/object-storage.service';
import { LibraryParserService } from './library-parser.service';

@Processor(LIBRARY_PARSE_QUEUE, { concurrency: Number(process.env.QUEUE_CONCURRENCY || 2) })
export class LibraryProcessor extends WorkerHost {
  constructor(
    @Inject(LibraryParserService) private readonly parser: LibraryParserService,
    @Inject(ObjectStorageService) private readonly storage: ObjectStorageService,
  ) {
    super();
  }

  async process(job: Job<Record<string, string>, void, string>): Promise<void> {
    if (job.name === PARSE_LIBRARY_FILE_JOB) {
      await this.parser.parse(job.data.fileId);
      return;
    }
    if (job.name === DELETE_LIBRARY_OBJECT_JOB) {
      await this.storage.delete(job.data.storageKey);
      return;
    }
    throw new Error(`Unsupported job ${job.name}`);
  }
}
