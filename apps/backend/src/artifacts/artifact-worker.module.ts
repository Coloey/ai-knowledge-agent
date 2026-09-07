import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { ARTIFACT_GENERATION_QUEUE } from '../queue/queue.constants';
import { StorageModule } from '../storage/storage.module';
import { ArtifactModule } from './artifact.module';
import { ArtifactProcessor } from './artifact.processor';

@Module({
  imports: [ArtifactModule, StorageModule, BullModule.registerQueue({ name: ARTIFACT_GENERATION_QUEUE })],
  providers: [ArtifactProcessor],
})
export class ArtifactWorkerModule {}
