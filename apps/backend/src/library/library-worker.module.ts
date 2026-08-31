import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { LIBRARY_PARSE_QUEUE } from '../queue/queue.constants';
import { LibraryCoreModule } from './library-core.module';
import { LibraryProcessor } from './library.processor';

@Module({
  imports: [LibraryCoreModule, BullModule.registerQueue({ name: LIBRARY_PARSE_QUEUE })],
  providers: [LibraryProcessor],
})
export class LibraryWorkerModule {}
