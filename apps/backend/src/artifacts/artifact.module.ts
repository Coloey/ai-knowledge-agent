import { Module } from '@nestjs/common';

import { StorageModule } from '../storage/storage.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ArtifactApplication } from './artifact.application';
import { ArtifactRepository } from './artifact.repository';
import { MarkdownReportRenderer } from './markdown-report.renderer';

@Module({
  imports: [StorageModule, WorkspacesModule],
  providers: [ArtifactApplication, ArtifactRepository, MarkdownReportRenderer],
  exports: [ArtifactApplication, ArtifactRepository, MarkdownReportRenderer],
})
export class ArtifactModule {}
