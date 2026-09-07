import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ARTIFACT_GENERATION_QUEUE, LIBRARY_PARSE_QUEUE } from '../queue/queue.constants';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { LibraryController } from './library.controller';
import { LibraryCoreModule } from './library-core.module';
import { LibraryService } from './library.service';
import { OutboxRelayService } from './outbox-relay.service';

@Module({
  imports: [
    AuthModule,
    WorkspacesModule,
    LibraryCoreModule,
    BullModule.registerQueue({ name: LIBRARY_PARSE_QUEUE }),
    BullModule.registerQueue({ name: ARTIFACT_GENERATION_QUEUE }),
  ],
  controllers: [LibraryController],
  providers: [LibraryService, OutboxRelayService],
})
export class LibraryApiModule {}
