import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ArtifactController } from './artifact.controller';
import { ArtifactModule } from './artifact.module';

@Module({
  imports: [AuthModule, ArtifactModule],
  controllers: [ArtifactController],
})
export class ArtifactApiModule {}
